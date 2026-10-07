'use strict';

const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
const { SandboxBankAdapter, SantanderBankAdapter } = require('./BankAdapter');

// Mesmo padrão exato de resolveSignatureAdapter (legal/signatures.service.js): fallback
// seguro pra SandboxBankAdapter sempre que o provider real não tiver credencial completa
// configurada — ausência de configuração NUNCA quebra o fluxo de negócio.
async function resolveBankAdapter(tenant, transaction) {
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
    if (clientId && clientSecret && certPem && keyPem && workspaceId) {
      const baseUrl = environment === 'production'
        ? 'https://api.santander.com.br'
        : 'https://trust-sandbox.api.santander.com.br';
      return new SantanderBankAdapter({ clientId, clientSecret, certPem, keyPem, workspaceId, baseUrl });
    }
  }

  return new SandboxBankAdapter();
}

module.exports = { resolveBankAdapter };
