'use strict';

const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
const AppError = require('../../../utils/AppError');
const { SandboxBankAdapter, SantanderBankAdapter } = require('./BankAdapter');

// B5 (revisão independente, conferência Nayara 18/10/2026):
//   - provider real (santander) com credencial incompleta FALHA FECHADO — antes caía em
//     silêncio para o sandbox e o "pagamento" seguia como se fosse real;
//   - sandbox é proibido no ambiente de produção (DEPLOY_ENVIRONMENT=production). Homologação e
//     desenvolvimento não definem essa variável e continuam usando o sandbox explicitamente.
let testOverride = null;

function setBankAdapterOverrideForTests(adapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Override de adapter bancário só em testes.');
  testOverride = adapter;
}

async function resolveBankAdapter(tenant, transaction) {
  if (testOverride && process.env.NODE_ENV === 'test') return testOverride;
  const provider = await getSetting('finance.payment_provider', tenant, transaction, 'sandbox');

  if (provider === 'santander') {
    const [clientId, clientSecret, certPem, keyPem, workspaceId, environment] = await Promise.all([
      getDecryptedSetting('finance.santander_client_id', tenant, transaction, null),
      getDecryptedSetting('finance.santander_client_secret', tenant, transaction, null),
      getDecryptedSetting('finance.santander_cert_pem', tenant, transaction, null),
      getDecryptedSetting('finance.santander_key_pem', tenant, transaction, null),
      getSetting('finance.santander_workspace_id', tenant, transaction, null),
      getSetting('finance.santander_environment', tenant, transaction, 'sandbox'),
    ]);
    if (!(clientId && clientSecret && certPem && keyPem && workspaceId)) {
      throw AppError.badRequest(
        'O provedor bancário Santander está configurado, mas a credencial está incompleta — corrija a configuração antes de enviar pagamentos.',
        'FINANCE_BANK_PROVIDER_CONFIG_MISSING'
      );
    }
    const baseUrl = environment === 'production' ? 'https://api.santander.com.br' : 'https://trust-sandbox.api.santander.com.br';
    return new SantanderBankAdapter({ clientId, clientSecret, certPem, keyPem, workspaceId, baseUrl });
  }

  if (provider !== 'sandbox') {
    throw AppError.badRequest(`Provedor bancário desconhecido: "${provider}".`, 'FINANCE_BANK_PROVIDER_UNKNOWN');
  }
  if (process.env.DEPLOY_ENVIRONMENT === 'production') {
    throw AppError.conflict(
      'O provedor bancário sandbox (simulação) não pode ser usado em produção.',
      'FINANCE_BANK_SANDBOX_FORBIDDEN_IN_PRODUCTION'
    );
  }
  return new SandboxBankAdapter();
}

module.exports = { resolveBankAdapter, setBankAdapterOverrideForTests };
