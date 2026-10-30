'use strict';

const { IntegrationConnection, TenantSetting } = require('../../../models');
const AppError = require('../../../utils/AppError');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
const registry = require('../../integrations/registry/registry.service');
const { transitionConnection } = require('../../integrations/registry/connections.transition');
const { getSecretStore, readConnectionSecret, webhookRefOf, isValidRef } = require('../../integrations/secrets');

/**
 * Segredos da seguradora no cofre (SecretStore), M9-D238 herdando a M9-D202. O segredo do cliente (Porto Seguro: `procurement.porto_seguro_client_secret`; Yelum:
 * `procurement.yelum_api_key`) e o segredo HMAC do webhook (`procurement.insurance_webhook_secret`) deixam de ser lidos de tenant_settings: a fonte única é o cofre, pela
 * referência da connection (`<secretRef>` e a irmã `<secretRef>/webhook-secret`). A migração é idempotente e acontece sozinha: o cliente, quando a connection do fornecedor é
 * criada a partir das credenciais já configuradas; o webhook, no primeiro webhook da empresa. Depois dela o valor deixa de existir em tenant_settings.
 */
const CREDENTIAL = Object.freeze({
  porto_seguro: { setting: 'procurement.porto_seguro_client_secret', extra: ['procurement.porto_seguro_client_id'], label: 'Porto Seguro' },
  yelum: { setting: 'procurement.yelum_api_key', extra: [], label: 'Yelum' },
});
const WEBHOOK_KEY = 'procurement.insurance_webhook_secret';
const NOT_FOUND_CODES = ['INTEGRATION_SECRET_NOT_FOUND', 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED', 'INTEGRATION_SECRET_STORE_CONFIG'];

const configMissing = (label) => AppError.badRequest(
  `O provedor de seguro ${label} está selecionado, mas a credencial está incompleta — corrija a configuração antes de cotar, emitir ou enviar sinistro.`,
  'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING',
);

const canonicalRef = (companyId, providerCode) => `company/${companyId}/insurance/${providerCode}`;

/** Connection ATIVA do fornecedor real criada a partir das credenciais configuradas: o segredo vai ao cofre e sai de tenant_settings. Credencial incompleta ou sem cofre: falha fechada. */
async function createRealConnection(ctx, key, providerCode, transaction) {
  const cred = CREDENTIAL[key];
  const [segredo, ...outros] = await Promise.all([cred.setting, ...cred.extra].map((k) => getDecryptedSetting(k, ctx, transaction, null)));
  if (!segredo || outros.some((v) => !v)) throw configMissing(cred.label);
  let store;
  try { store = getSecretStore(); } catch { throw configMissing(cred.label); }
  const secretRef = canonicalRef(ctx.companyId, providerCode);
  const criada = await registry.createConnection({ providerCode, environment: registry.getServerEnvironment(), label: `Seguros: ${providerCode} (${ctx.companyId.slice(0, 8)})`, secretRef }, ctx, transaction);
  await store.put(secretRef, segredo, {});
  await TenantSetting.destroy({ where: { companyId: ctx.companyId, key: cred.setting }, force: true, transaction }); // exclusão de verdade: o valor cifrado não pode ficar na linha apagada
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'procurement.insurance.credential_migrated_to_vault', entityType: 'IntegrationConnection', entityId: criada.id,
    afterJson: { secretRef, providerCode }, reason: `A credencial de "${providerCode}" passou para o cofre de segredos e saiu das configurações da empresa.`,
  }, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

/** A connection de seguro da empresa a quem o webhook pertence: a do fornecedor escolhido; senão qualquer connection de fornecedor de seguro da empresa. */
async function findInsuranceConnection(tenant, transaction) {
  const { PROVIDER_CODES } = require('./insurance.connection');
  const escolhido = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  const where = { companyId: tenant.companyId };
  const preferida = await IntegrationConnection.findOne({ where: { ...where, providerCode: PROVIDER_CODES[escolhido] || PROVIDER_CODES.sandbox }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
  if (preferida) return preferida;
  return IntegrationConnection.findOne({ where: { ...where, providerCode: Object.values(PROVIDER_CODES) }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
}

async function readFromVault(connection, tenant, transaction) {
  if (!connection || !isValidRef(connection.secretRef)) return null;
  try {
    const entrega = await readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction });
    return entrega.value.reveal();
  } catch (err) {
    if (NOT_FOUND_CODES.includes(err.code)) return null;
    throw err;
  }
}

/** Leva o valor antigo ao cofre e tira a linha de tenant_settings. Devolve true quando migrou. */
async function migrateWebhookSecret({ tenant, connection, valor }, transaction) {
  let store;
  try { store = getSecretStore(); } catch { return false; }
  const anterior = connection.secretRef || null;
  let atual = connection;
  if (!isValidRef(anterior) || !anterior.startsWith(`company/${tenant.companyId}/`)) {
    atual = await registry.updateConnection(connection.id, { secretRef: canonicalRef(tenant.companyId, connection.providerCode) }, { ...tenant, userId: tenant.userId || null }, transaction);
  }
  await store.put(webhookRefOf(atual.secretRef), valor, {});
  await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: WEBHOOK_KEY }, force: true, transaction });
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'procurement.insurance.webhook_secret_migrated_to_vault', entityType: 'IntegrationConnection', entityId: atual.id,
    afterJson: { secretRef: atual.secretRef, referenciaAnterior: anterior }, reason: 'O segredo do webhook da seguradora passou para o cofre de segredos e saiu das configurações da empresa.',
  }, transaction);
  return true;
}

/**
 * Segredo HMAC do webhook da seguradora. Devolve { secret }: o texto (ou null). Lê do cofre; se só existir o valor antigo em tenant_settings e houver connection e cofre, migra
 * agora (idempotente). Sem cofre configurado (desenvolvimento) ou sem connection, o valor antigo continua valendo.
 */
async function resolveInsuranceWebhookSecret({ tenant, transaction }) {
  const connection = await findInsuranceConnection(tenant, transaction);
  const doCofre = await readFromVault(connection, tenant, transaction);
  if (doCofre) return { secret: doCofre };
  const antigo = await getDecryptedSetting(WEBHOOK_KEY, tenant, transaction, null);
  if (antigo && connection) {
    try {
      await migrateWebhookSecret({ tenant, connection, valor: antigo }, transaction);
    } catch (err) {
      logger.warn({ err: err.message, code: err.code }, 'Segredo do webhook de seguro: a migração para o cofre falhou; o valor antigo segue valendo.');
    }
  }
  return { secret: antigo || null };
}

/** A credencial do fornecedor já está no cofre (connection com referência)? Serve ao quadro de configuração: depois da migração o valor sai de tenant_settings. */
async function credentialInVault(tenant, key, transaction) {
  const { PROVIDER_CODES } = require('./insurance.connection');
  const connection = await IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: PROVIDER_CODES[key], status: 'ACTIVE' }, transaction });
  return Boolean(connection && isValidRef(connection.secretRef));
}

module.exports = { createRealConnection, resolveInsuranceWebhookSecret, migrateWebhookSecret, credentialInVault, canonicalRef, CREDENTIAL, WEBHOOK_KEY };
