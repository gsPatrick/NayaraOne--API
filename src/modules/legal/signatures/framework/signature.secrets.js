'use strict';

const { IntegrationConnection, TenantSetting } = require('../../../../models');
const logger = require('../../../../utils/logger');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getDecryptedSetting, getSetting } = require('../../../../features/settings/settings.service');
const registry = require('../../../../features/integrations/registry/registry.service');
const { getSecretStore, readConnectionSecret, webhookRefOf, isValidRef } = require('../../../../features/integrations/secrets');
const { PROVIDER_CODES } = require('./signature.connection');

/**
 * Segredo HMAC do webhook do fornecedor de assinatura (M9-D236, herdado da M9-D202): a fonte única passa a ser o cofre de segredos (SecretStore), pela referência irmã
 * `<secretRef>/webhook-secret` da connection do fornecedor. O valor antigo (`legal.clicksign_webhook_secret` e `legal.zapsign_webhook_secret` em tenant_settings) migra
 * sozinho na primeira vez que um webhook da empresa chega: vai para o cofre, a connection ganha a referência no formato do cofre e a linha sai de tenant_settings.
 * Idempotente: sem a linha antiga, não há o que migrar. Sem cofre configurado (desenvolvimento) ou sem connection, o valor antigo continua valendo.
 */
const keyOf = (providerKey) => `legal.${providerKey}_webhook_secret`;

async function readFromVault(connection, tenant, transaction) {
  if (!connection || !isValidRef(connection.secretRef)) return null;
  try {
    const entrega = await readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction });
    return entrega.value.reveal();
  } catch (err) {
    if (['INTEGRATION_SECRET_NOT_FOUND', 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED', 'INTEGRATION_SECRET_STORE_CONFIG'].includes(err.code)) return null;
    throw err;
  }
}

async function migrateToVault({ tenant, connection, providerKey, valor }, transaction) {
  let store;
  try { store = getSecretStore(); } catch { return false; }
  const canonica = `company/${tenant.companyId}/signature/${PROVIDER_CODES[providerKey]}`;
  const anterior = connection.secretRef || null;
  let atual = connection;
  if (!isValidRef(anterior) || !anterior.startsWith(`company/${tenant.companyId}/`)) {
    atual = await registry.updateConnection(connection.id, { secretRef: canonica }, { ...tenant, userId: tenant.userId || null }, transaction);
  }
  await store.put(webhookRefOf(atual.secretRef), valor, {});
  await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: keyOf(providerKey) }, force: true, transaction }); // exclusão de verdade: o valor cifrado não pode ficar na linha apagada
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'legal.signature.webhook_secret_migrated_to_vault', entityType: 'IntegrationConnection', entityId: atual.id,
    beforeJson: { secretRef: anterior, origem: 'tenant_settings', setting: keyOf(providerKey) }, afterJson: { secretRef: atual.secretRef, referenciaAnterior: anterior }, reason: `O segredo do webhook de "${providerKey}" passou para o cofre de segredos e saiu das configurações da empresa.`,
  }, transaction);
  return true;
}

/** Devolve { secret, legacyStored }: o texto do segredo (ou null) e se existe valor antigo em tenant_settings. */
async function resolveSignatureWebhookSecret({ providerKey, tenant, transaction }) {
  const connection = await IntegrationConnection.findOne({
    where: { companyId: tenant.companyId, providerCode: PROVIDER_CODES[providerKey] }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction,
  });
  const doCofre = await readFromVault(connection, tenant, transaction);
  if (doCofre) return { secret: doCofre, legacyStored: false };
  const antigo = await getDecryptedSetting(keyOf(providerKey), tenant, transaction, null);
  if (antigo && connection) {
    try {
      await migrateToVault({ tenant, connection, providerKey, valor: antigo }, transaction);
    } catch (err) {
      logger.warn({ providerKey, err: err.message, code: err.code }, 'Segredo do webhook de assinatura: a migração para o cofre falhou; o valor antigo segue valendo.');
    }
  }
  const guardado = antigo ? true : Boolean(await getSetting(keyOf(providerKey), tenant, transaction, null));
  return { secret: antigo || null, legacyStored: guardado };
}

module.exports = { resolveSignatureWebhookSecret, migrateToVault, keyOf };
