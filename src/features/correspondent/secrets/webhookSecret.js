'use strict';

const { IntegrationConnection, TenantSetting } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getDecryptedSetting, getSetting } = require('../../settings/settings.service');
const registry = require('../../integrations/registry/registry.service');
const { getSecretStore, readConnectionSecret, webhookRefOf, isValidRef, uniqueCanonicalRef } = require('../../integrations/secrets');
const { catalogLegacy: { toCatalogCode } } = require('../../integrations');

/**
 * Segredo HMAC do webhook do provider de financiamento (M9-D240, herdado da M9-D202). A fonte única passa a ser o cofre de segredos (SecretStore):
 * `readConnectionSecret(connection, ..., { kind: 'webhook' })` lê a referência irmã `<secretRef>/webhook-secret` da connection FINANCING do provider.
 * O valor antigo (`correspondent.<provider>_webhook_secret` em tenant_settings) e as referências `vault:...` do Marco 8 migram sozinhos, na primeira vez que um webhook da
 * empresa chega: o valor vai para o cofre, a connection ganha a referência no formato do cofre (`company/<id>/financing/<provider>`) e a linha sai de tenant_settings.
 * Idempotente: sem a linha antiga, não há o que migrar. Sem cofre configurado (ambiente de desenvolvimento sem SECRET_STORE_DRIVER) o valor antigo continua valendo.
 */
const keyOf = (providerCode) => `correspondent.${providerCode}_webhook_secret`;

async function findConnection(companyId, catalogCode, transaction) {
  return IntegrationConnection.findOne({ where: { companyId, providerCode: catalogCode }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
}

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

/** Leva o valor antigo ao cofre e tira a linha de tenant_settings. Devolve true quando migrou. */
async function migrateToVault({ tenant, connection, catalogCode, providerCode, valor }, transaction) {
  let store;
  try { store = getSecretStore(); } catch { return false; }
  const canonica = await uniqueCanonicalRef(connection, `company/${tenant.companyId}/financing/${catalogCode}`, transaction);
  const anterior = connection.secretRef || null;
  let atual = connection;
  if (!isValidRef(anterior) || !anterior.startsWith(`company/${tenant.companyId}/`)) {
    atual = await registry.updateConnection(connection.id, { secretRef: canonica }, { ...tenant, userId: tenant.userId || null }, transaction);
  }
  await store.put(webhookRefOf(atual.secretRef), valor, {});
  await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: keyOf(providerCode) }, force: true, transaction }); // exclusão de verdade: o valor cifrado não pode ficar na linha apagada
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'correspondent.webhook_secret.migrated_to_vault', entityType: 'IntegrationConnection', entityId: atual.id,
    afterJson: { secretRef: atual.secretRef, referenciaAnterior: anterior }, reason: `O segredo do webhook de "${providerCode}" passou para o cofre de segredos e saiu das configurações da empresa.`,
  }, transaction);
  return true;
}

/**
 * Devolve { secret, legacyStored }: o texto do segredo (ou null) e se existe valor antigo em tenant_settings (para a mensagem de recusa saber distinguir "ilegível" de
 * "não configurado"). Migra o valor antigo para o cofre quando há cofre e connection.
 */
async function resolveWebhookSecret({ providerCode, tenant, transaction }) {
  const catalogCode = toCatalogCode(providerCode);
  const connection = await findConnection(tenant.companyId, catalogCode, transaction);
  const doCofre = await readFromVault(connection, tenant, transaction);
  if (doCofre) return { secret: doCofre, legacyStored: false };
  const antigo = await getDecryptedSetting(keyOf(providerCode), tenant, transaction, null);
  if (antigo && connection) {
    try {
      await migrateToVault({ tenant, connection, catalogCode, providerCode, valor: antigo }, transaction);
    } catch (err) {
      logger.warn({ providerCode, err: err.message, code: err.code }, 'Segredo do webhook: a migração para o cofre falhou; o valor antigo segue valendo.');
    }
  }
  const guardado = antigo ? true : Boolean(await getSetting(keyOf(providerCode), tenant, transaction, null));
  return { secret: antigo || null, legacyStored: guardado };
}

module.exports = { resolveWebhookSecret, migrateToVault, keyOf };
