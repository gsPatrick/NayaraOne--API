'use strict';

const { IntegrationConnection, TenantSetting } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getDecryptedSetting, getSetting } = require('../../settings/settings.service');
const registry = require('../../integrations/registry/registry.service');
const { getSecretStore, readConnectionSecret, webhookRefOf, isValidRef } = require('../../integrations/secrets');
const { providerCodeOf } = require('./bank.constants');
const { configuredProviderKey } = require('./bank.connection');

/**
 * Segredos do banco no cofre (M9-D237, herdado da M9-D202): a fonte única passa a ser o SecretStore. `finance.santander_client_secret` vira o segredo da API da connection
 * `bank-santander`; `finance.bank_payment_webhook_secret` vira o segredo do webhook (`<secretRef>/webhook-secret`) da connection do provedor configurado. Os valores antigos migram
 * sozinhos, de forma idempotente: o valor vai ao cofre, a connection ganha a referência no formato do cofre (`company/<id>/bank/<código>`) e a linha sai de tenant_settings.
 * Sem cofre configurado (desenvolvimento sem SECRET_STORE_DRIVER) o valor antigo continua valendo. Credencial bancária só é lida pelo worker (D202).
 */
const SEGREDOS = Object.freeze([
  { setting: 'finance.santander_client_secret', kind: 'api', code: () => 'bank-santander' },
  { setting: 'finance.bank_payment_webhook_secret', kind: 'webhook', code: (key) => providerCodeOf(key) },
]);

async function findOrCreateConnection(ctx, providerCode, transaction) {
  const existente = await IntegrationConnection.findOne({ where: { companyId: ctx.companyId, providerCode }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
  if (existente) return existente;
  return registry.createConnection({ providerCode, environment: registry.getServerEnvironment(), label: `Financeiro: ${providerCode} (${ctx.companyId.slice(0, 8)})` }, ctx, transaction);
}

async function migrateOne({ ctx, item, providerKey }, transaction) {
  const valor = await getDecryptedSetting(item.setting, ctx, transaction, null);
  if (!valor) return null;
  let store;
  try { store = getSecretStore(); } catch { return null; } // sem cofre configurado, o valor antigo segue valendo
  const code = item.code(providerKey);
  const connection = await findOrCreateConnection(ctx, code, transaction);
  const canonica = `company/${ctx.companyId}/bank/${code}`;
  const anterior = connection.secretRef || null;
  let atual = connection;
  if (!isValidRef(anterior) || !anterior.startsWith(`company/${ctx.companyId}/`)) {
    // Migração do sistema (sem pessoa para o MFA da troca de credencial): grava a referência direto, com a auditoria abaixo.
    await connection.update({ secretRef: canonica }, { transaction });
    atual = connection;
  }
  await store.put(item.kind === 'webhook' ? webhookRefOf(atual.secretRef) : atual.secretRef, valor, {});
  await TenantSetting.destroy({ where: { companyId: ctx.companyId, key: item.setting }, force: true, transaction }); // exclusão de verdade: o valor cifrado não pode ficar na linha apagada
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'finance.bank_secret.migrated_to_vault', entityType: 'IntegrationConnection', entityId: atual.id,
    beforeJson: { secretRef: anterior }, afterJson: { setting: item.setting, secretRef: atual.secretRef, referenciaAnterior: anterior }, reason: `O segredo "${item.setting}" passou para o cofre de segredos e saiu das configurações da empresa.`,
  }, transaction);
  return item.setting;
}

/** Migra os segredos bancários que ainda estão em tenant_settings. Devolve { migrated: [chaves] }. */
async function migrateBankSecrets(ctx, transaction) {
  const providerKey = await configuredProviderKey(ctx, transaction);
  const migrated = [];
  for (const item of SEGREDOS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const feito = await migrateOne({ ctx, item, providerKey }, transaction);
      if (feito) migrated.push(feito);
    } catch (err) {
      logger.warn({ setting: item.setting, err: err.message, code: err.code }, 'Segredo bancário: a migração para o cofre falhou; o valor antigo segue valendo.');
    }
  }
  return { migrated };
}

/** Segredo do webhook lido do cofre; cofre local em produção é recusado (INTEGRATION_SECRET_DRIVER_FORBIDDEN). Sem cofre ou sem valor: null. */
async function readBankWebhookSecretFromVault(connection, tenant, transaction) {
  if (!connection || !isValidRef(connection.secretRef)) return null;
  try {
    const entrega = await readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction });
    return entrega.value.reveal();
  } catch (err) {
    if (['INTEGRATION_SECRET_NOT_FOUND', 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED', 'INTEGRATION_SECRET_STORE_CONFIG'].includes(err.code)) return null;
    throw err;
  }
}

/** { secret, legacyStored }: o texto do segredo do webhook (ou null) e se ainda existe valor antigo em tenant_settings. Migra o valor antigo quando há cofre. */
async function resolveBankWebhookSecret({ tenant, transaction }) {
  const providerKey = await configuredProviderKey(tenant, transaction);
  const code = providerCodeOf(providerKey);
  const connection = await IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: code }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
  const doCofre = await readBankWebhookSecretFromVault(connection, tenant, transaction);
  if (doCofre) return { secret: doCofre, legacyStored: false };
  const antigo = await getDecryptedSetting('finance.bank_payment_webhook_secret', tenant, transaction, null);
  if (antigo) {
    await migrateBankSecrets({ ...tenant, userId: tenant.userId || null }, transaction);
    const depois = await IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: code }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
    const migrado = await readBankWebhookSecretFromVault(depois, tenant, transaction).catch(() => null);
    if (migrado) return { secret: migrado, legacyStored: false };
  }
  const guardado = antigo ? true : Boolean(await getSetting('finance.bank_payment_webhook_secret', tenant, transaction, null));
  return { secret: antigo || null, legacyStored: guardado };
}

module.exports = { migrateBankSecrets, resolveBankWebhookSecret, readBankWebhookSecretFromVault };
