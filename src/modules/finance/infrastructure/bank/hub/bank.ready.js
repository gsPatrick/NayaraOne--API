'use strict';

const { IntegrationConnection } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { getDecryptedSetting, getSetting } = require('../../../../../features/settings/settings.service');
const { isValidRef } = require('../../../../../features/integrations/secrets');
const { getBankLegacyOverride } = require('../resolve-bank-adapter');
const { configuredProviderKey } = require('./bank.connection');
const { migrateBankSecrets } = require('./bank.secrets');

const configMissing = () => AppError.badRequest(
  'O provedor bancário Santander está configurado, mas a credencial está incompleta — corrija a configuração antes de enviar pagamentos.', 'FINANCE_BANK_PROVIDER_CONFIG_MISSING',
);

/**
 * O provedor bancário da empresa está pronto para receber ordens? Falha FECHADO antes de qualquer estado mudar (B5): sandbox é proibido em produção; o Santander exige
 * credencial completa (segredo do cliente no cofre ou ainda no cadastro antigo, que migra aqui para o cofre, mais certificado, chave e workspace). Não constrói o adapter:
 * quem fala com o banco é o worker de envios, pelo registro de integrações.
 */
async function assertBankProviderReady(tenant, transaction) {
  if (getBankLegacyOverride()) return 'sandbox';
  const key = await configuredProviderKey(tenant, transaction);
  if (key === 'sandbox') {
    if (process.env.DEPLOY_ENVIRONMENT === 'production') {
      throw AppError.conflict('O provedor bancário sandbox (simulação) não pode ser usado em produção.', 'FINANCE_BANK_SANDBOX_FORBIDDEN_IN_PRODUCTION');
    }
    return key;
  }
  await migrateBankSecrets(tenant, transaction);
  const connection = await IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: 'bank-santander' }, order: [['status', 'ASC'], ['created_at', 'ASC']], transaction });
  const segredo = (connection && isValidRef(connection.secretRef)) || Boolean(await getDecryptedSetting('finance.santander_client_secret', tenant, transaction, null));
  const [clientId, certPem, keyPem, workspaceId] = await Promise.all([
    getDecryptedSetting('finance.santander_client_id', tenant, transaction, null), getDecryptedSetting('finance.santander_cert_pem', tenant, transaction, null),
    getDecryptedSetting('finance.santander_key_pem', tenant, transaction, null), getSetting('finance.santander_workspace_id', tenant, transaction, null),
  ]);
  if (!(segredo && clientId && certPem && keyPem && workspaceId)) throw configMissing();
  return key;
}

module.exports = { assertBankProviderReady };
