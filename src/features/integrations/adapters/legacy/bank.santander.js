'use strict';

const { BankAdapter } = require('../../providers/bank/bank.port');
const { SantanderBankAdapter } = require('../../../finance/adapters/BankAdapter');
const { getDecryptedSetting, getSetting } = require('../../../settings/settings.service');
const AppError = require('../../../../utils/AppError');
const { wrapLegacy } = require('../legacyWrap');
const { STATUS, OPS, CAPABILITIES } = require('./bank.ops');

const HOSTS = Object.freeze(['api.santander.com.br', 'trust-sandbox.api.santander.com.br']);

/**
 * O Santander não tem consulta por chave de idempotência: a pergunta "essa ordem existe?" não tem resposta conclusiva, então o envio incerto fica para a revisão
 * humana em vez de reenviar às cegas (a chave segue no cabeçalho X-Idempotency-Key, que o banco usa para devolver a ordem já criada).
 */
const semConsultaPorChave = async () => { throw Object.assign(new Error('O Santander não oferece consulta por chave de idempotência.'), { code: 'INTEGRATION_LOOKUP_UNSUPPORTED' }); };

/** O objeto antigo (mTLS + OAuth2): o segredo do cliente vem do cofre (SecretStore) e o resto da configuração da empresa (certificado, chave, workspace) de tenant_settings. */
async function makeSantander(ctx, meta) {
  const tenant = meta && meta.tenant;
  const transaction = meta && meta.transaction;
  if (!tenant) throw AppError.internal('Configuração do provider Santander incompleta.', 'FINANCE_BANK_PROVIDER_CONFIG_MISSING');
  const segredo = await ctx.secret('dispatch');
  const [clientId, certPem, keyPem, workspaceId, environment] = await Promise.all([
    getDecryptedSetting('finance.santander_client_id', tenant, transaction, null),
    getDecryptedSetting('finance.santander_cert_pem', tenant, transaction, null),
    getDecryptedSetting('finance.santander_key_pem', tenant, transaction, null),
    getSetting('finance.santander_workspace_id', tenant, transaction, null),
    getSetting('finance.santander_environment', tenant, transaction, 'sandbox'),
  ]);
  const baseUrl = ctx.connection.environment === 'PRODUCTION' || environment === 'production' ? 'https://api.santander.com.br' : 'https://trust-sandbox.api.santander.com.br';
  return new SantanderBankAdapter({ clientId, clientSecret: segredo.value.reveal(), certPem, keyPem, workspaceId, baseUrl });
}

/** bank-santander: o adapter real, sem mudar o comportamento, sob o contrato do port BankAdapter. A saúde só confirma que a credencial abre no cofre. */
const BankSantanderContractAdapter = wrapLegacy({
  Port: BankAdapter,
  className: 'BankSantanderContractAdapter',
  code: 'bank-santander',
  capabilities: CAPABILITIES,
  makeLegacy: makeSantander,
  mapper: STATUS,
  ops: OPS,
  idempotentOps: ['submitPayment'],
  lookups: { findByIdempotencyKey: semConsultaPorChave },
  hosts: HOSTS,
  health: async (ctx) => {
    const t0 = Date.now();
    try { await ctx.secret('test-connection'); return { ok: true, latencyMs: Date.now() - t0, detail: 'Credencial lida do cofre; sem chamada de teste ao banco.' }; } catch { return { ok: false, latencyMs: Date.now() - t0, detail: 'Credencial indisponível no cofre.' }; }
  },
});

module.exports = { BankSantanderContractAdapter, makeSantander };
