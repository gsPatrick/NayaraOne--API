'use strict';

const { Op } = require('sequelize');
const { TenantSetting } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { encryptSecret, decryptSecret } = require('../../utils/mfaCrypto');

/**
 * SETTINGS_SCHEMA — dicionário fail-closed de chaves conhecidas do painel admin de
 * configurações por tenant. `upsertSetting` REJEITA (400) qualquer chave que não esteja aqui
 * ou qualquer valor fora da faixa/tipo esperado — nunca aceita "o que vier" silenciosamente.
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: as faixas abaixo (0-100% para
 * percentuais, 1-120 minutos para janela de MFA) são limites de sanidade de engenharia (evitar
 * configuração absurda, ex. multa de 500% ou step-up de 0 minutos), não um requisito de negócio
 * documentado — a confirmar com o cliente antes de produção.
 */
const SETTINGS_SCHEMA = {
  'billing.late_fee_percentage': { type: 'number', min: 0, max: 100 },
  'billing.interest_percentage': { type: 'number', min: 0, max: 100 },
  'billing.grace_period_days': { type: 'integer', min: 0 },
  'billing.default_index_code': { type: 'string' },
  'mfa.step_up_ttl_minutes': { type: 'integer', min: 1, max: 120 },
  'mfa.required_for_sensitive_roles': { type: 'boolean' },
  'legal.signature_provider': { type: 'string', enum: ['sandbox', 'clicksign', 'zapsign'] },
  // Campos abaixo são segredos de provedor externo — CRIPTOGRAFADOS em repouso (AES-256-GCM,
  // ver src/utils/mfaCrypto.js) seguindo o mesmo padrão já usado para o segredo TOTP
  // (src/features/users/mfa.service.js). `upsertSetting` criptografa antes de gravar;
  // `getDecryptedSetting` é o único ponto que decifra, e só no escopo da chamada que precisa
  // do valor em texto claro (nunca guardar o valor decifrado além disso).
  'legal.clicksign_api_token': { type: 'string', encrypted: true },
  // A conta do Clicksign (token de "Access token" no painel) é OU produção OU sandbox — nunca
  // as duas; um token de produção é rejeitado (401) contra a URL de sandbox e vice-versa. Sem
  // esse dado, o adapter não tem como saber qual base URL usar (ver ClicksignSignatureAdapter).
  'legal.clicksign_environment': { type: 'string', enum: ['production', 'sandbox'] },
  'legal.zapsign_api_token': { type: 'string', encrypted: true },
  'legal.clicksign_webhook_secret': { type: 'string', encrypted: true },
  'legal.zapsign_webhook_secret': { type: 'string', encrypted: true },
  'billing.igpm_mode': { type: 'string', enum: ['manual', 'automatic'] },
  'billing.fgv_api_token': { type: 'string', encrypted: true },
};

function validateAgainstSchema(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) {
    throw AppError.badRequest(`Chave de configuração desconhecida: "${key}".`, 'SETTING_UNKNOWN_KEY', { key });
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw AppError.badRequest(`O valor de "${key}" deve ser numérico.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      throw AppError.badRequest(`O valor de "${key}" deve ser um número inteiro.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.min !== undefined && value < spec.min) {
      throw AppError.badRequest(`O valor de "${key}" deve ser >= ${spec.min}.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (spec.max !== undefined && value > spec.max) {
      throw AppError.badRequest(`O valor de "${key}" deve ser <= ${spec.max}.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    return;
  }

  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw AppError.badRequest(`O valor de "${key}" deve ser booleano.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    return;
  }

  if (spec.type === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw AppError.badRequest(`O valor de "${key}" deve ser uma string não vazia.`, 'SETTING_INVALID_VALUE', { key, value });
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      throw AppError.badRequest(
        `O valor de "${key}" deve ser um dos seguintes: ${spec.enum.join(', ')}.`,
        'SETTING_INVALID_VALUE',
        { key, value }
      );
    }
    return;
  }

  // Fail closed: tipo de schema desconhecido/não implementado nunca é aceito silenciosamente.
  throw AppError.badRequest(`Tipo de schema não suportado para "${key}".`, 'SETTING_SCHEMA_ERROR', { key });
}

/**
 * getSetting — nunca lança erro por ausência de configuração: se a chave não estiver
 * configurada para o tenant (ou se `tenant`/`transaction` estiverem ausentes/incompletos —
 * ex.: chamada fora de contexto de tenant), retorna `defaultValue` silenciosamente. Isso é
 * proposital: leitura de configuração é sempre "best effort com fallback seguro", nunca deve
 * derrubar um fluxo de negócio (ex.: cálculo de multa) por falta de configuração — quem decide
 * fail-closed é o Motor de Regras (ver collectionCase.service.js), não este helper.
 */
async function getSetting(key, tenant, transaction, defaultValue = null) {
  try {
    if (!tenant || !tenant.companyId) return defaultValue;
    const row = await TenantSetting.findOne({
      where: { companyId: tenant.companyId, key },
      transaction,
    });
    if (!row) return defaultValue;
    return row.value;
  } catch (err) {
    // Fail-safe: qualquer erro tratável (ex.: transaction inválida) retorna o default em vez
    // de propagar — leitura de configuração nunca deve derrubar o chamador.
    return defaultValue;
  }
}

/**
 * getDecryptedSetting — mesma semântica "best effort com fallback seguro" de `getSetting`,
 * mas para chaves marcadas `encrypted: true` no SETTINGS_SCHEMA: decifra o valor armazenado e
 * retorna o segredo em texto claro. O valor decifrado deve viver só no escopo da chamada que
 * o usa (ex.: montar o header Authorization de uma chamada HTTP) — nunca deve ser guardado em
 * memória além disso (cache, variável de módulo etc.). Qualquer falha (chave ausente, valor
 * corrompido, erro de decifragem) retorna `defaultValue` — nunca lança, pelo mesmo motivo de
 * `getSetting`: leitura de configuração não pode derrubar o fluxo de negócio.
 */
async function getDecryptedSetting(key, tenant, transaction, defaultValue = null) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec || !spec.encrypted) {
    // Fail closed: só decifra chaves explicitamente marcadas como segredo no schema.
    return defaultValue;
  }
  const raw = await getSetting(key, tenant, transaction, null);
  if (!raw) return defaultValue;
  try {
    return decryptSecret(raw);
  } catch (err) {
    return defaultValue;
  }
}

/**
 * upsertSetting — cria ou atualiza (UPSERT por UNIQUE(company_id, key)) uma configuração de
 * tenant. Fail closed: chave desconhecida ou valor fora do schema é rejeitado com AppError 400
 * ANTES de qualquer escrita no banco.
 */
async function upsertSetting(key, value, tenant, actorUserId, transaction) {
  if (!tenant || !tenant.groupId || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (groupId/companyId) é obrigatório para configurar settings.', 'SETTING_TENANT_REQUIRED');
  }

  validateAgainstSchema(key, value);

  // Campos marcados `encrypted: true` no schema são criptografados ANTES de tocar o banco —
  // a coluna `value` (JSONB) nunca guarda o segredo em texto plano. `beforeJson`/`afterJson`
  // da auditoria também usam a linha já com o valor criptografado (row.toJSON()), então a
  // auditoria nunca expõe o segredo em texto claro.
  const spec = SETTINGS_SCHEMA[key];
  const storedValue = spec && spec.encrypted ? encryptSecret(value) : value;

  const existing = await TenantSetting.findOne({ where: { companyId: tenant.companyId, key }, transaction });
  const beforeJson = existing ? existing.toJSON() : null;

  let row;
  if (existing) {
    existing.value = storedValue;
    existing.updatedBy = actorUserId || null;
    await existing.save({ transaction });
    row = existing;
  } else {
    row = await TenantSetting.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        key,
        value: storedValue,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      actorUserId,
      action: beforeJson ? 'settings.update' : 'settings.create',
      entityType: 'TenantSetting',
      entityId: row.id,
      beforeJson,
      afterJson: row.toJSON(),
      reason: `Configuração "${key}" ${beforeJson ? 'atualizada' : 'criada'} para o tenant.`,
    },
    transaction
  );

  return row;
}

async function listSettingsByPrefix(prefix, tenant, transaction) {
  if (!tenant || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (companyId) é obrigatório para listar settings.', 'SETTING_TENANT_REQUIRED');
  }
  const where = { companyId: tenant.companyId };
  if (prefix) where.key = { [Op.like]: `${prefix}%` };
  return TenantSetting.findAll({ where, order: [['key', 'ASC']], transaction });
}

async function getSettingRow(key, tenant, transaction) {
  if (!tenant || !tenant.companyId) {
    throw AppError.badRequest('Contexto de tenant (companyId) é obrigatório para consultar settings.', 'SETTING_TENANT_REQUIRED');
  }
  const row = await TenantSetting.findOne({ where: { companyId: tenant.companyId, key }, transaction });
  if (!row) {
    throw AppError.notFound(`Configuração "${key}" não encontrada para este tenant.`, 'SETTING_NOT_FOUND');
  }
  return row;
}

const INTEGRATION_STATUS_TIMEOUT_MS = 5000;

/**
 * pingProvider — executa `fn(signal)` (uma chamada HTTP real e barata ao provedor) sob um
 * timeout curto (5s por padrão), pra nunca travar a tela de configurações esperando resposta
 * de rede de terceiro. Nunca lança: qualquer falha (erro HTTP, rede, timeout) vira
 * `connected: false` com um motivo, e só timeout usa o reason 'timeout' explicitamente.
 */
async function pingProvider(fn, timeoutMs = INTEGRATION_STATUS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fn(controller.signal);
    return { connected: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { connected: false, reason: 'timeout' };
    }
    return { connected: false, reason: 'auth_or_network_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * getIntegrationsStatus — pra cada integração externa configurável no painel (Clicksign,
 * ZapSign, FGV/IGPM), faz uma chamada real mínima ao provedor pra confirmar que o token
 * funciona, sem nunca devolver o segredo em texto claro (só usa o valor decifrado no escopo
 * desta chamada de rede, nunca no retorno). Se não houver token configurado para o provider
 * ativo, retorna `configured: false` e nem tenta testar rede.
 */
async function getIntegrationsStatus(tenant, transaction) {
  const checkedAt = new Date().toISOString();

  const result = {
    clicksign: { configured: false, connected: false, checkedAt },
    zapsign: { configured: false, connected: false, checkedAt },
    igpm: { configured: false, connected: false, checkedAt },
  };

  const signatureProvider = await getSetting('legal.signature_provider', tenant, transaction, 'sandbox');

  if (signatureProvider === 'clicksign') {
    const token = await getDecryptedSetting('legal.clicksign_api_token', tenant, transaction, null);
    if (token) {
      const environment = await getSetting('legal.clicksign_environment', tenant, transaction, 'production');
      const baseUrl = environment === 'sandbox' ? 'https://sandbox.clicksign.com/api/v3' : 'https://app.clicksign.com/api/v3';
      const ping = await pingProvider(async (signal) => {
        const response = await fetch(`${baseUrl}/envelopes?page%5Bsize%5D=1`, {
          headers: { Accept: 'application/vnd.api+json', Authorization: token },
          signal,
        });
        if (!response.ok) throw new Error(`Clicksign respondeu ${response.status}.`);
      });
      result.clicksign = { configured: true, checkedAt, ...ping };
    }
  } else if (signatureProvider === 'zapsign') {
    const token = await getDecryptedSetting('legal.zapsign_api_token', tenant, transaction, null);
    if (token) {
      const ping = await pingProvider(async (signal) => {
        const response = await fetch('https://api.zapsign.com.br/api/v1/docs/?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) throw new Error(`ZapSign respondeu ${response.status}.`);
      });
      result.zapsign = { configured: true, checkedAt, ...ping };
    }
  }

  // FGV/IGPM: só depende de rede quando o modo é 'automatic'. Em 'manual' (ou qualquer outro
  // valor não-automático) não há dependência externa nenhuma — é sempre "verde".
  const igpmMode = await getSetting('billing.igpm_mode', tenant, transaction, 'manual');
  if (igpmMode === 'automatic') {
    const token = await getDecryptedSetting('billing.fgv_api_token', tenant, transaction, null);
    if (token) {
      const period = new Date().toISOString().slice(0, 7).replace('-', '');
      const ping = await pingProvider(async (signal) => {
        const response = await fetch(`https://api.fgvdados.fgv.br/v1/indicadores/igpm/${period}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (!response.ok) throw new Error(`FGV respondeu ${response.status}.`);
      });
      result.igpm = { configured: true, checkedAt, ...ping };
    }
  } else {
    result.igpm = { configured: true, connected: true, checkedAt };
  }

  return result;
}

module.exports = {
  SETTINGS_SCHEMA,
  getSetting,
  getDecryptedSetting,
  upsertSetting,
  listSettingsByPrefix,
  getSettingRow,
  getIntegrationsStatus,
};
