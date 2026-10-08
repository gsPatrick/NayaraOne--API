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
  // FIN-005 (contrato bruto, Centro Financeiro §2 "Princípios constitucionais": "Limites vêm
  // do Motor de Regras; aprovação usa snapshot/hash.") — o QUANTO (multiplicador/limiar em
  // R$) é ajustável aqui, mas o SE a regra de antifraude está ativa para o tenant continua
  // decidido pelo Motor de Regras (evaluateRule('FIN-005', ...), fail-closed) — mesmo padrão
  // já usado em billing.late_fee_percentage/REG-LOC-001 (collectionCase.service.js).
  'finance.antifraud_history_multiplier': { type: 'number', min: 1 },
  'finance.antifraud_new_account_threshold': { type: 'number', min: 0 },
  // FIN-TS-013 "Conta nova | Pagamento alto imediato | Controle extra" — período de
  // resfriamento (em horas) de conta bancária nova/alterada, mesma regra FIN-005.
  'finance.bank_account_cooldown_hours': { type: 'integer', min: 0 },
  // EST-013 / Guia §12 (NAY Estoque, inventoryNay.service.js): lead time padrão (dias) usado
  // pela sugestão de compra quando o item ainda não tem histórico real de reposição
  // (pedido de compra -> recebimento) para medir o prazo observado.
  'inventory.nay_default_lead_time_days': { type: 'integer', min: 0, max: 365 },
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
  // Provider bancário (PaymentProvider/BankAdapter) — mesmo padrão de legal.signature_provider.
  // Ver PROVIDER_BANCARIO.md. "sandbox" é o default seguro: sem credencial configurada, o
  // resolver cai pra SandboxBankAdapter e nenhum fluxo de negócio trava.
  'finance.payment_provider': { type: 'string', enum: ['sandbox', 'santander'] },
  'finance.santander_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'finance.santander_workspace_id': { type: 'string' },
  'finance.santander_client_id': { type: 'string', encrypted: true },
  'finance.santander_client_secret': { type: 'string', encrypted: true },
  // Certificado A1 mTLS exigido pela API do Santander — par chave/certificado, ambos em texto
  // PEM, criptografados em repouso como qualquer outro segredo de provider.
  'finance.santander_cert_pem': { type: 'string', encrypted: true },
  'finance.santander_key_pem': { type: 'string', encrypted: true },
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 38, 2026-10-05): mesma falha de
  // segurança do webhook de seguro (corrigida na R37) — bankPaymentPublicWebhook nunca validava
  // assinatura nenhuma, permitindo forjar confirmação de pagamento bancário real. Mesmo esquema
  // HMAC-SHA256 por tenant, fail-closed quando há provider real configurado.
  'finance.bank_payment_webhook_secret': { type: 'string', encrypted: true },
  // Insurance Hub (Marco 7 — "COMPRAS/PROCUREMENT + SEGUROS", InsuranceAdapter). Mesmo padrão:
  // "sandbox" é o default seguro, resolver cai pra SandboxInsuranceAdapter sem credencial.
  // "junto_seguros" fica como enum válido (selecionável no front, documentado como "pendente de
  // parceria de corretora") mas NUNCA tem settings de credencial aqui — não há documentação
  // técnica pública pra essa seguradora, então não existe campo real pra pedir (ver
  // InsuranceAdapter.js — JuntoSegurosInsuranceAdapter lança sempre que instanciada).
  'procurement.insurance_provider': { type: 'string', enum: ['sandbox', 'porto_seguro', 'junto_seguros', 'yelum'] },
  // Porto Seguro: OAuth2 client_credentials CONFIRMADO (dev.portoseguro.com.br/api-portal/
  // content/autorizacao) — client_id/client_secret, não um api_key único.
  'procurement.porto_seguro_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'procurement.porto_seguro_client_id': { type: 'string', encrypted: true },
  'procurement.porto_seguro_client_secret': { type: 'string', encrypted: true },
  'procurement.yelum_environment': { type: 'string', enum: ['sandbox', 'production'] },
  'procurement.yelum_api_key': { type: 'string', encrypted: true },
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 37, 2026-10-05): o webhook público
  // de seguradora (insurancePublicWebhook) não validava assinatura nenhuma — qualquer
  // requisição que conhecesse o externalSubmissionId conseguia forjar liquidação de sinistro e
  // lançamento financeiro arbitrário. Mesmo padrão já usado pro Clicksign
  // (legal.clicksign_webhook_secret) — um secret por tenant, HMAC-SHA256 do corpo bruto.
  'procurement.insurance_webhook_secret': { type: 'string', encrypted: true },
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
    bankPayment: { configured: false, connected: false, checkedAt },
    insurance: { configured: false, connected: false, checkedAt },
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

  // Santander (PROVIDER_BANCARIO.md): autenticação exige mTLS (certificado A1) + OAuth2, não um
  // simples bearer token, então aqui só confirmamos que as 5 credenciais necessárias estão
  // salvas — resolveBankAdapter.js já usa essa mesma lista pra decidir entre o adapter real e o
  // Sandbox. Não há "ping" de rede real (não vale abrir uma conexão mTLS só pra health-check
  // deste painel); "Conectado" aqui significa "configurado por completo", não "testado contra o
  // banco" — a mesma distinção que já vale pro resto desta função quando não há chamada de rede.
  const bankPaymentProvider = await getSetting('finance.payment_provider', tenant, transaction, 'sandbox');
  if (bankPaymentProvider === 'santander') {
    const [clientId, clientSecret, certPem, keyPem, workspaceId] = await Promise.all([
      getDecryptedSetting('finance.santander_client_id', tenant, transaction, null),
      getDecryptedSetting('finance.santander_client_secret', tenant, transaction, null),
      getDecryptedSetting('finance.santander_cert_pem', tenant, transaction, null),
      getDecryptedSetting('finance.santander_key_pem', tenant, transaction, null),
      getSetting('finance.santander_workspace_id', tenant, transaction, null),
    ]);
    const complete = Boolean(clientId && clientSecret && certPem && keyPem && workspaceId);
    result.bankPayment = { configured: complete, connected: complete, checkedAt };
  } else {
    result.bankPayment = { configured: true, connected: true, checkedAt };
  }

  // Insurance Hub (Marco 7): mesma distinção do Santander acima — nenhuma seguradora foi
  // testada contra credencial real, então "Conectado" aqui significa "configurado por
  // completo", não "testado contra a seguradora".
  const insuranceProvider = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  if (insuranceProvider === 'porto_seguro') {
    const [clientId, clientSecret] = await Promise.all([
      getDecryptedSetting('procurement.porto_seguro_client_id', tenant, transaction, null),
      getDecryptedSetting('procurement.porto_seguro_client_secret', tenant, transaction, null),
    ]);
    const complete = Boolean(clientId && clientSecret);
    result.insurance = { configured: complete, connected: complete, checkedAt };
  } else if (insuranceProvider === 'yelum') {
    const apiKey = await getDecryptedSetting('procurement.yelum_api_key', tenant, transaction, null);
    result.insurance = { configured: Boolean(apiKey), connected: Boolean(apiKey), checkedAt };
  } else if (insuranceProvider === 'junto_seguros') {
    // Nunca "configurado" de verdade — não existe credencial real pra essa seguradora ainda
    // (ver nota em InsuranceAdapter.js/resolveInsuranceAdapter.js). Selecionar essa opção no
    // painel cai no Sandbox silenciosamente; aqui refletimos isso como "não configurado".
    result.insurance = { configured: false, connected: false, checkedAt };
  } else {
    result.insurance = { configured: true, connected: true, checkedAt };
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
