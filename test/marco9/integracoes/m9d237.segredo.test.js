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

const ordem = [['status', 'ASC'], ['created_at', 'ASC']]; // a mesma escolha do código (bank.secrets): a connection mais antiga do menor status

// Hermético: tudo dentro de uma transação descartada (nada fica no banco para a próxima passada) e as connections `bank-santander` que outros testes deixaram ficam sem
// referência dentro dela, para a migração e a leitura olharem a mesma connection e a referência canônica ser a esperada.
test('m9_d237_segredo_lido_pelo_secretstore', async () => {
  const desligar = useTempSecretStore();
  try {
    await env.withRollbackTenantTransaction(tenant, async (t) => {
      const upsert = (chave, valor) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t);
      const existe = async (chave) => (await sequelize.query('SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = :k', { replacements: { c: tenant.companyId, k: chave }, transaction: t }))[0][0].n;
      const cliente = `cs-${uniqueSuffix()}`;
      const webhook = `wh-${uniqueSuffix()}`;
      await sequelize.query("UPDATE integration.connections SET secret_ref = NULL WHERE company_id = :c AND provider_code = 'bank-santander'", { replacements: { c: tenant.companyId }, transaction: t });
      await upsert('finance.payment_provider', 'santander');
      await upsert('finance.santander_client_secret', cliente);
      await upsert('finance.bank_payment_webhook_secret', webhook);
      assert.deepEqual([await existe('finance.santander_client_secret'), await existe('finance.bank_payment_webhook_secret')], [1, 1]);
      const migrou = await bank.migrateBankSecrets(env.ctxDe(), t);
      assert.equal(migrou.migrated.length, 2);
      assert.deepEqual([await existe('finance.santander_client_secret'), await existe('finance.bank_payment_webhook_secret')], [0, 0], 'depois da migração o valor deixa de existir em tenant_settings');
      const connection = await IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: 'bank-santander' }, order: ordem, transaction: t });
      assert.equal(connection.secretRef, `company/${tenant.companyId}/bank/bank-santander`);
      const lidoApi = await readConnectionSecret(connection, tenant, { purpose: 'dispatch', transaction: t });
      const lidoWebhook = await readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction: t });
      assert.deepEqual([lidoApi.value.reveal(), lidoWebhook.value.reveal()], [cliente, webhook], 'lidos pelo SecretStore (readConnectionSecret)');
      const segunda = await bank.migrateBankSecrets(env.ctxDe(), t);
      assert.equal(segunda.migrated.length, 0, 'a migração é idempotente');
      // o segredo do webhook que o Financeiro usa para conferir a assinatura vem do cofre
      const lido = await bank.resolveBankWebhookSecret({ tenant: env.ctxDe(), transaction: t });
      assert.equal(lido.secret, webhook);
    });
  } finally { desligar(); }
});

/** Cadastro manual de connection bancária com segredo exige MFA recente (D202); o teste desliga a exigência só durante a criação. */
async function semMfaNaTroca(fn, t) {
  const troca = (valor) => require('../../helpers/mfaRecente').gravarParametroSensivel('integration.secret.mfa_on_bank_secret_change', valor, tenant, t); // sensível: operador com MFA recente real
  await troca(false);
  try { return await fn(); } finally { await troca(true); }
}

test('banco_credencial_cofre_obrigatorio_em_producao', async () => {
  const desligar = useTempSecretStore(); // cofre de arquivo: proibido para BANK em PRODUÇÃO (M9-D202)
  try {
    // dentro de uma transação descartada: a connection marcada como produção não pode ficar no banco para a próxima passada
    await env.withRollbackTenantTransaction(tenant, async (t) => {
      const conta = await semMfaNaTroca(() => registry.createConnection({
        providerCode: 'bank-santander', environment: 'SANDBOX', label: `QA-M9 banco prod ${uniqueSuffix()}`, secretRef: `company/${tenant.companyId}/bank/prod-${uniqueSuffix()}`,
      }, env.ctxDe(), t), t);
      // criar connection de produção exige MFA ao vivo; o teste cria em sandbox e marca a produção direto no banco para provar a regra de leitura do segredo
      await sequelize.query("UPDATE integration.connections SET environment = 'PRODUCTION' WHERE id = :id", { replacements: { id: conta.id }, transaction: t });
      const connection = await IntegrationConnection.findByPk(conta.id, { transaction: t });
      await assert.rejects(readConnectionSecret(connection, tenant, { purpose: 'dispatch', transaction: t }), (e) => e.code === 'INTEGRATION_SECRET_DRIVER_FORBIDDEN');
      await assert.rejects(bank.readBankWebhookSecretFromVault(connection, tenant, t), (e) => e.code === 'INTEGRATION_SECRET_DRIVER_FORBIDDEN', 'o webhook do banco também não lê de cofre local em produção');
    });
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
  const { getSecretStore } = require('../../../src/features/integrations/secrets');
  const desligar = useTempSecretStore();
  try {
    await env.withRollbackTenantTransaction(tenant, async (t) => {
      const upsert = (chave, valor) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t);
      const conexao = await semMfaNaTroca(() => registry.createConnection({
        providerCode: 'bank-santander', environment: 'SANDBOX', label: `QA-M9 santander ${uniqueSuffix()}`, secretRef: `company/${tenant.companyId}/bank/sa-${uniqueSuffix()}`,
      }, env.ctxDe(), t), t);
      await getSecretStore().put(conexao.secretRef, 'segredo-do-cliente', {});
      await upsert('finance.santander_client_id', 'cid');
      await upsert('finance.santander_cert_pem', 'CERT');
      await upsert('finance.santander_key_pem', 'KEY');
      await upsert('finance.santander_workspace_id', 'ws-1');
      const connection = await IntegrationConnection.findByPk(conexao.id, { transaction: t });
      const adapter = await adapterRegistry.resolve(connection, env.ctxDe(), t);
      const legado = await adapter.legacy(adapter.ctx, { tenant: env.ctxDe(), transaction: t });
      assert.ok(legado instanceof SantanderBankAdapter);
      assert.equal(legado.clientSecret, 'segredo-do-cliente');
      assert.equal(legado.workspaceId, 'ws-1');
    });
  } finally { desligar(); }
});
