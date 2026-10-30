'use strict';

// Marco 9, M9-D237 — segredos do banco no SecretStore (migração idempotente que tira o valor de tenant_settings), cofre real em produção e Santander no registro.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d237Env');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');
const settingsService = require('../../../src/features/settings/settings.service');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { readConnectionSecret } = require('../../../src/features/integrations/secrets');
const { IntegrationConnection, IntegrationProvider } = require('../../../src/models');
const { BankSantanderContractAdapter } = require('../../../src/features/integrations/adapters/legacy/bank.santander');
const bank = require('../../../src/features/finance/bank');

const { sequelize, withTenantTransaction, uniqueSuffix } = env;
let tenant;
before(async () => { tenant = await env.carregar(); });
after(async () => { await sequelize.close(); });

const definir = (chave, valor) => withTenantTransaction(tenant, (t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t));
const guardado = (chave) => withTenantTransaction(tenant, async (t) => (await sequelize.query('SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = :k', { replacements: { c: tenant.companyId, k: chave }, transaction: t }))[0][0].n);
const noBanco = (sql, replacements) => withTenantTransaction(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]);

test('m9_d237_segredo_lido_pelo_secretstore', async () => {
  const desligar = useTempSecretStore();
  try {
    const cliente = `cs-${uniqueSuffix()}`;
    const webhook = `wh-${uniqueSuffix()}`;
    await definir('finance.payment_provider', 'santander');
    await definir('finance.santander_client_secret', cliente);
    await definir('finance.bank_payment_webhook_secret', webhook);
    assert.deepEqual([await guardado('finance.santander_client_secret'), await guardado('finance.bank_payment_webhook_secret')], [1, 1]);
    const migrou = await withTenantTransaction(tenant, (t) => bank.migrateBankSecrets(env.ctxDe(), t));
    assert.equal(migrou.migrated.length, 2);
    assert.deepEqual([await guardado('finance.santander_client_secret'), await guardado('finance.bank_payment_webhook_secret')], [0, 0], 'depois da migração o valor deixa de existir em tenant_settings');
    const connection = await withTenantTransaction(tenant, (t) => IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: 'bank-santander' }, transaction: t }));
    assert.equal(connection.secretRef, `company/${tenant.companyId}/bank/bank-santander`);
    const lidoApi = await withTenantTransaction(tenant, (t) => readConnectionSecret(connection, tenant, { purpose: 'dispatch', transaction: t }));
    const lidoWebhook = await withTenantTransaction(tenant, (t) => readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction: t }));
    assert.deepEqual([lidoApi.value.reveal(), lidoWebhook.value.reveal()], [cliente, webhook], 'lidos pelo SecretStore (readConnectionSecret)');
    const segunda = await withTenantTransaction(tenant, (t) => bank.migrateBankSecrets(env.ctxDe(), t));
    assert.equal(segunda.migrated.length, 0, 'a migração é idempotente');
    // o segredo do webhook que o Financeiro usa para conferir a assinatura vem do cofre
    const lido = await withTenantTransaction(tenant, (t) => bank.resolveBankWebhookSecret({ tenant: env.ctxDe(), transaction: t }));
    assert.equal(lido.secret, webhook);
  } finally {
    await definir('finance.payment_provider', 'sandbox');
    desligar();
  }
});

/** Cadastro manual de connection bancária com segredo exige MFA recente (D202); o teste desliga a exigência só durante a criação. */
async function semMfaNaTroca(fn) {
  await definir('integration.secret.mfa_on_bank_secret_change', false);
  try { return await fn(); } finally { await definir('integration.secret.mfa_on_bank_secret_change', true); }
}

test('banco_credencial_cofre_obrigatorio_em_producao', async () => {
  const desligar = useTempSecretStore(); // cofre de arquivo: proibido para BANK em PRODUÇÃO (M9-D202)
  try {
    const conta = await semMfaNaTroca(() => withTenantTransaction(tenant, (t) => registry.createConnection({
      providerCode: 'bank-santander', environment: 'SANDBOX', label: `QA-M9 banco prod ${uniqueSuffix()}`, secretRef: `company/${tenant.companyId}/bank/prod-${uniqueSuffix()}`,
    }, env.ctxDe(), t)));
    // criar connection de produção exige MFA ao vivo; o teste cria em sandbox e marca a produção direto no banco para provar a regra de leitura do segredo
    await noBanco("UPDATE integration.connections SET environment = 'PRODUCTION' WHERE id = :id", { id: conta.id });
    const connection = await withTenantTransaction(tenant, (t) => IntegrationConnection.findByPk(conta.id, { transaction: t }));
    await assert.rejects(withTenantTransaction(tenant, (t) => readConnectionSecret(connection, tenant, { purpose: 'dispatch', transaction: t })), (e) => e.code === 'INTEGRATION_SECRET_DRIVER_FORBIDDEN');
    await assert.rejects(withTenantTransaction(tenant, (t) => bank.readBankWebhookSecretFromVault(connection, tenant, t)), (e) => e.code === 'INTEGRATION_SECRET_DRIVER_FORBIDDEN', 'o webhook do banco também não lê de cofre local em produção');
  } finally { desligar(); }
});

test('banco_santander_registrado_no_registro_de_adapters', async () => {
  assert.equal(adapterRegistry.has('bank-santander'), true);
  const linha = await withTenantTransaction(tenant, (t) => IntegrationProvider.findByPk('bank-santander', { transaction: t }));
  assert.equal(linha.domain, 'BANK');
  assert.deepEqual([...linha.capabilities].sort(), ['getPaymentStatus', 'getStatement', 'submitPayment', 'verifyWebhook']);
  assert.equal(new BankSantanderContractAdapter(null).providerCode(), 'bank-santander');
  // o objeto antigo (mTLS + OAuth2) continua sendo quem executa, com a credencial vinda do cofre
  const { SantanderBankAdapter } = require('../../../src/features/finance/adapters/BankAdapter');
  const desligar = useTempSecretStore();
  try {
    const conexao = await semMfaNaTroca(() => withTenantTransaction(tenant, (t) => registry.createConnection({
      providerCode: 'bank-santander', environment: 'SANDBOX', label: `QA-M9 santander ${uniqueSuffix()}`, secretRef: `company/${tenant.companyId}/bank/sa-${uniqueSuffix()}`,
    }, env.ctxDe(), t)));
    const { getSecretStore } = require('../../../src/features/integrations/secrets');
    await getSecretStore().put(conexao.secretRef, 'segredo-do-cliente', {});
    await definir('finance.santander_client_id', 'cid');
    await definir('finance.santander_cert_pem', 'CERT');
    await definir('finance.santander_key_pem', 'KEY');
    await definir('finance.santander_workspace_id', 'ws-1');
    const legado = await withTenantTransaction(tenant, async (t) => {
      const connection = await IntegrationConnection.findByPk(conexao.id, { transaction: t });
      const adapter = await adapterRegistry.resolve(connection, env.ctxDe(), t);
      return adapter.legacy(adapter.ctx, { tenant: env.ctxDe(), transaction: t });
    });
    assert.ok(legado instanceof SantanderBankAdapter);
    assert.equal(legado.clientSecret, 'segredo-do-cliente');
    assert.equal(legado.workspaceId, 'ws-1');
  } finally { desligar(); }
});
