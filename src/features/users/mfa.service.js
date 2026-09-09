'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { MfaCredential, MfaStepUp, User } = require('../../models');
const AppError = require('../../utils/AppError');
const { encryptSecret, decryptSecret } = require('../../utils/mfaCrypto');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getSetting } = require('../settings/settings.service');

const BCRYPT_ROUNDS = 10;
const RECOVERY_CODE_COUNT = 8;
const ISSUER = 'Nayara One';

// DECISÃO DE ENGENHARIA — não especificado no Caderno: duração da "janela de MFA recente".
// O Caderno pede "janela configurável por risco" sem dar um número. Adotamos um único TTL
// (10 minutos por default), configurável agora por tenant via painel de settings
// (`mfa.step_up_ttl_minutes`, ver src/features/settings/settings.service.js) — a env var
// MFA_STEP_UP_TTL_MINUTES vira apenas o fallback de ÚLTIMO CASO, usado só quando o tenant não
// configurou nada no painel (preserva comportamento anterior a este módulo). Não implementamos
// TTL diferenciado por nível de risco (LOW/MEDIUM/HIGH/CRITICAL) porque o documento não define
// os valores, e inventar números por risco sem base seria pior do que um único TTL explícito
// por tenant. Valor a confirmar com o cliente antes de produção.
const STEP_UP_TTL_MINUTES_ENV_DEFAULT = Number(process.env.MFA_STEP_UP_TTL_MINUTES || 10);

// DECISÃO DE ENGENHARIA — não especificado no Caderno: limite de tentativas falhas e duração
// do bloqueio. O Caderno pede "tentativas repetidas/falhas conforme política" sem definir o
// número — 5 tentativas / 15 minutos de bloqueio é um valor conservador comum (ex.: mesma
// ordem de grandeza usada por provedores de TOTP populares), ajustável depois se o cliente
// pedir outro valor. Fail closed: ao atingir o limite, TODA tentativa (mesmo com código certo)
// é rejeitada até o bloqueio expirar — nunca "deixa passar" por segurança.
const MAX_FAILED_MFA_ATTEMPTS = 5;
const MFA_LOCKOUT_MINUTES = 15;

/**
 * hashDeviceFingerprint — não é fingerprinting robusto de dispositivo (não há client-side
 * fingerprint/cookie dedicado neste marco); é um hash do IP + User-Agent da requisição, usado
 * só para DETECTAR e AUDITAR quando uma verificação de MFA vem de uma origem diferente da
 * última conhecida. Nunca bloqueia a ação por isso (IP dinâmico/rede corporativa com NAT são
 * legítimos e mudam) — apenas gera um evento de auditoria distinto para revisão humana.
 */
function hashDeviceFingerprint(requestMeta) {
  if (!requestMeta || (!requestMeta.ip && !requestMeta.userAgent)) return null;
  return crypto
    .createHash('sha256')
    .update(`${requestMeta.ip || ''}::${requestMeta.userAgent || ''}`)
    .digest('hex');
}

/**
 * resolveStepUpTtlMinutes — resolve o TTL da janela de MFA recente para o tenant: prefere
 * `mfa.step_up_ttl_minutes` (settings do tenant); cai para a env var (ou 10) só se ausente.
 * Assíncrona porque `getSetting` lê do banco (tenant_settings) — os chamadores (verifyMfa) já
 * são assíncronos e já têm `transaction`/`actorContext` disponíveis.
 */
async function resolveStepUpTtlMinutes(actorContext, transaction) {
  const configured = await getSetting('mfa.step_up_ttl_minutes', actorContext, transaction, null);
  if (configured !== null && configured !== undefined) {
    return Number(configured);
  }
  return STEP_UP_TTL_MINUTES_ENV_DEFAULT;
}

function generateRecoveryCodes() {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

async function getCredentialForUser(userId, transaction) {
  return MfaCredential.findOne({ where: { userId }, transaction });
}

/**
 * setupMfa — gera um novo segredo TOTP para o usuário e retorna o otpauth:// URI (para QR
 * code no front). NÃO habilita MFA ainda — só `confirm` (com o primeiro código válido) faz
 * isso. Se já existir um setup pendente (não confirmado) para o usuário, ele é substituído
 * (permite reiniciar setup sem travar o usuário que perdeu o app autenticador antes de confirmar).
 */
async function setupMfa(userId, actorContext, transaction) {
  const user = await User.findByPk(userId, { transaction });
  if (!user) {
    throw AppError.notFound('Usuário não encontrado.', 'MFA_USER_NOT_FOUND');
  }

  const secret = authenticator.generateSecret();
  const existing = await getCredentialForUser(userId, transaction);

  if (existing) {
    if (existing.enabled) {
      throw AppError.conflict('MFA já está habilitado para este usuário. Desabilite antes de reconfigurar.', 'MFA_ALREADY_ENABLED');
    }
    existing.secretEncrypted = encryptSecret(secret);
    existing.recoveryCodesHash = [];
    existing.confirmedAt = null;
    existing.updatedBy = userId;
    await existing.save({ transaction });
  } else {
    await MfaCredential.create(
      {
        userId,
        groupId: actorContext.groupId,
        companyId: actorContext.companyId,
        secretEncrypted: encryptSecret(secret),
        enabled: false,
        recoveryCodesHash: [],
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction }
    );
  }

  const otpauthUri = authenticator.keyuri(user.email, ISSUER, secret);
  return { otpauthUri };
}

/**
 * confirmMfa — recebe o primeiro código TOTP gerado pelo app autenticador do usuário; se
 * válido, marca mfaEnabled=true (em User) e enabled=true/confirmedAt (em MfaCredential), e
 * gera os códigos de recuperação — retornados em TEXTO PLANO uma única vez (só o hash fica
 * persistido; se o usuário perder essa tela, os códigos são irrecuperáveis, só é possível
 * gerar novos via reconfiguração).
 */
async function confirmMfa(userId, code, actorContext, transaction) {
  const credential = await getCredentialForUser(userId, transaction);
  if (!credential || credential.enabled) {
    throw AppError.badRequest('Nenhum setup de MFA pendente para este usuário. Chame /mfa/setup primeiro.', 'MFA_SETUP_NOT_FOUND');
  }

  const secret = decryptSecret(credential.secretEncrypted);
  const isValid = code && authenticator.check(String(code), secret);
  if (!isValid) {
    throw AppError.badRequest('Código TOTP inválido.', 'MFA_INVALID_CODE');
  }

  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodesHash = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)));

  credential.enabled = true;
  credential.confirmedAt = new Date();
  credential.recoveryCodesHash = recoveryCodesHash;
  credential.updatedBy = userId;
  await credential.save({ transaction });

  await User.update(
    { mfaEnabled: true, mfaMethod: 'TOTP', updatedBy: userId },
    { where: { id: userId }, transaction }
  );

  await registrarAuditoria(
    {
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId: userId,
      action: 'users.mfa.confirm',
      entityType: 'User',
      entityId: userId,
      reason: 'MFA (TOTP) habilitado para o usuário.',
    },
    transaction
  );

  return { recoveryCodes };
}

/**
 * verifyMfa — verifica um código TOTP (ou um código de recuperação de uso único como
 * fallback) e, se válido, abre/renova a janela de "MFA recente" (mfa_step_ups), usada por
 * `requireRecentMfa` para liberar ações de step-up (aprovação de pagamento, liquidação,
 * alteração bancária etc — 03_MOTORES_TRANSVERSAIS.md §3.4).
 */
/**
 * assertNotLocked — fail closed: se o usuário estourou `MAX_FAILED_MFA_ATTEMPTS` recentemente,
 * rejeita QUALQUER tentativa (mesmo com código certo) até `locked_until` expirar.
 */
function assertNotLocked(credential) {
  if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
    const remainingMinutes = Math.ceil((credential.lockedUntil.getTime() - Date.now()) / 60000);
    throw AppError.forbidden(
      `Muitas tentativas de código inválido. Tente novamente em ${remainingMinutes} minuto(s).`,
      'MFA_LOCKED'
    );
  }
}

/**
 * registerFailedAttempt — incrementa o contador de falhas e, ao atingir o limite, bloqueia por
 * `MFA_LOCKOUT_MINUTES` e audita o bloqueio (evento distinto de "código inválido" comum, para
 * dar visibilidade a um possível ataque de força bruta).
 */
async function registerFailedAttempt(credential, userId, actorContext, transaction) {
  credential.failedAttempts += 1;
  let justLocked = false;
  if (credential.failedAttempts >= MAX_FAILED_MFA_ATTEMPTS) {
    credential.lockedUntil = new Date(Date.now() + MFA_LOCKOUT_MINUTES * 60 * 1000);
    credential.failedAttempts = 0;
    justLocked = true;
  }
  await credential.save({ transaction });

  if (justLocked) {
    await registrarAuditoria(
      {
        groupId: actorContext.groupId,
        companyId: actorContext.companyId,
        actorUserId: userId,
        action: 'users.mfa.locked',
        entityType: 'User',
        entityId: userId,
        reason: `Bloqueado por ${MFA_LOCKOUT_MINUTES} minutos após ${MAX_FAILED_MFA_ATTEMPTS} tentativas seguidas de código MFA inválido.`,
      },
      transaction
    );
  }
}

async function verifyMfa(userId, code, actorContext, transaction, requestMeta = null) {
  const credential = await getCredentialForUser(userId, transaction);
  if (!credential || !credential.enabled) {
    throw AppError.forbidden('MFA não está habilitado para este usuário. Habilite o MFA antes de continuar.', 'MFA_NOT_ENABLED');
  }
  assertNotLocked(credential);
  if (!code) {
    throw AppError.badRequest('O campo "code" é obrigatório.', 'MFA_VALIDATION');
  }

  const secret = decryptSecret(credential.secretEncrypted);
  let valid = authenticator.check(String(code), secret);
  let usedRecoveryCode = false;

  if (!valid && credential.recoveryCodesHash.length > 0) {
    const normalized = String(code).trim().toUpperCase();
    for (let i = 0; i < credential.recoveryCodesHash.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(normalized, credential.recoveryCodesHash[i])) {
        valid = true;
        usedRecoveryCode = true;
        // Consumo de uso único: remove o hash usado do array — nunca reutilizável.
        const remaining = credential.recoveryCodesHash.slice();
        remaining.splice(i, 1);
        credential.recoveryCodesHash = remaining;
        break;
      }
    }
  }

  if (!valid) {
    await registerFailedAttempt(credential, userId, actorContext, transaction);
    throw AppError.unauthorized('Código MFA inválido.', 'MFA_INVALID_CODE');
  }

  // Sucesso: zera o contador de falhas (não deixa "acumular" entre tentativas legítimas).
  credential.failedAttempts = 0;

  // Detecção de novo dispositivo/origem (não bloqueia — só audita, ver hashDeviceFingerprint).
  const fingerprint = hashDeviceFingerprint(requestMeta);
  const isNewDevice = Boolean(fingerprint && credential.lastDeviceFingerprint && fingerprint !== credential.lastDeviceFingerprint);
  if (fingerprint) credential.lastDeviceFingerprint = fingerprint;
  await credential.save({ transaction });

  const ttlMinutes = await resolveStepUpTtlMinutes(actorContext, transaction);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  const [stepUp] = await MfaStepUp.findOrBuild({
    where: { userId },
    defaults: {
      userId,
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      verifiedAt: now,
      expiresAt,
      createdBy: userId,
      updatedBy: userId,
    },
    transaction,
  });
  stepUp.verifiedAt = now;
  stepUp.expiresAt = expiresAt;
  stepUp.groupId = actorContext.groupId;
  stepUp.companyId = actorContext.companyId;
  stepUp.updatedBy = userId;
  await stepUp.save({ transaction });

  await registrarAuditoria(
    {
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId: userId,
      action: 'users.mfa.verify',
      entityType: 'User',
      entityId: userId,
      reason: usedRecoveryCode
        ? 'Verificação MFA bem-sucedida usando código de recuperação (janela de step-up aberta).'
        : 'Verificação MFA (TOTP) bem-sucedida — janela de step-up aberta.',
    },
    transaction
  );

  if (isNewDevice) {
    await registrarAuditoria(
      {
        groupId: actorContext.groupId,
        companyId: actorContext.companyId,
        actorUserId: userId,
        action: 'users.mfa.new_device',
        entityType: 'User',
        entityId: userId,
        reason: 'Verificação MFA bem-sucedida a partir de uma origem (IP/dispositivo) diferente da última conhecida — sinalizado para revisão, não bloqueado.',
      },
      transaction
    );
  }

  return { verifiedAt: now, expiresAt, usedRecoveryCode, isNewDevice };
}

/**
 * disableMfa — exige um código TOTP atual válido (não um código de recuperação — decisão de
 * engenharia: desabilitar é uma ação sensível, exigimos o mesmo fator "algo que você tem"
 * intacto, não um código de emergência já pensado para acesso, não para desligar proteção).
 */
async function disableMfa(userId, code, actorContext, transaction) {
  const credential = await getCredentialForUser(userId, transaction);
  if (!credential || !credential.enabled) {
    throw AppError.badRequest('MFA não está habilitado para este usuário.', 'MFA_NOT_ENABLED');
  }
  assertNotLocked(credential);
  const secret = decryptSecret(credential.secretEncrypted);
  if (!code || !authenticator.check(String(code), secret)) {
    await registerFailedAttempt(credential, userId, actorContext, transaction);
    throw AppError.unauthorized('Código TOTP inválido — não é possível desabilitar o MFA.', 'MFA_INVALID_CODE');
  }

  await credential.destroy({ transaction });
  await MfaStepUp.destroy({ where: { userId }, transaction });
  await User.update(
    { mfaEnabled: false, mfaMethod: null, updatedBy: userId },
    { where: { id: userId }, transaction }
  );

  await registrarAuditoria(
    {
      groupId: actorContext.groupId,
      companyId: actorContext.companyId,
      actorUserId: userId,
      action: 'users.mfa.disable',
      entityType: 'User',
      entityId: userId,
      reason: 'MFA (TOTP) desabilitado para o usuário.',
    },
    transaction
  );

  return { mfaEnabled: false };
}

/**
 * hasRecentMfa — usado por requireRecentMfa (auth.middleware.js) e por services que aplicam
 * step-up MFA diretamente (approvals.service.js quando risco HIGH/CRITICAL).
 */
async function hasRecentMfa(userId, transaction) {
  const stepUp = await MfaStepUp.findOne({ where: { userId }, transaction });
  if (!stepUp) return false;
  return stepUp.expiresAt.getTime() > Date.now();
}

/**
 * assertRecentMfa — fail closed: lança 403 se o usuário não tiver MFA habilitado (pede pra
 * habilitar primeiro, nunca abre exceção silenciosa) ou não tiver verificação recente válida.
 */
async function assertRecentMfa(userId, transaction) {
  const credential = await getCredentialForUser(userId, transaction);
  if (!credential || !credential.enabled) {
    throw AppError.forbidden(
      'Esta ação exige MFA habilitado. Configure o MFA em "/users/me/mfa/setup" antes de continuar.',
      'MFA_REQUIRED_NOT_ENABLED'
    );
  }
  const recent = await hasRecentMfa(userId, transaction);
  if (!recent) {
    throw AppError.forbidden(
      'Esta ação exige verificação MFA recente. Verifique seu código em "/users/me/mfa/verify" e tente novamente.',
      'MFA_STEP_UP_REQUIRED'
    );
  }
}

module.exports = {
  setupMfa,
  confirmMfa,
  verifyMfa,
  disableMfa,
  hasRecentMfa,
  assertRecentMfa,
  resolveStepUpTtlMinutes,
  STEP_UP_TTL_MINUTES: STEP_UP_TTL_MINUTES_ENV_DEFAULT,
};
