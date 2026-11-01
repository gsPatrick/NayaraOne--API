'use strict';

// Marco 9, M9-D240 — webhook do financiamento sobre o registro genérico: caixa de entrada nova com dedup, rota pública legada e segredo no cofre.
process.env.PORT = process.env.M9D240_WEBHOOK_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('../../../app');
const env = require('../_helpers/m9d240Env');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');
const webhooks = require('../../../src/features/correspondent/webhooks.service');
const settingsService = require('../../../src/features/settings/settings.service');
const { readConnectionSecret } = require('../../../src/features/integrations/secrets');
const { IntegrationConnection, FinancingCase } = require('../../../src/models');

const { sequelize, withTenantTransaction, uniqueSuffix, submissionsService } = env;
let tenant;
const casos = [];

before(async () => { tenant = await env.carregar(); await new Promise((resolve) => setTimeout(resolve, 300)); });
after(async () => {
  if (casos.length) {
    await sequelize.query('DELETE FROM correspondent.external_case_routing WHERE financing_case_id = ANY(ARRAY[:ids]::uuid[])', { replacements: { ids: casos } });
    await FinancingCase.destroy({ where: { id: casos } });
  }
  await sequelize.close();
  process.exit(0);
});

const definirSegredo = (valor) => withTenantTransaction(tenant, (t) => settingsService.upsertSetting('correspondent.sandbox_webhook_secret', valor, tenant, tenant.userId, t));
const segredoGuardado = () => withTenantTransaction(tenant, async (t) => (await sequelize.query(
  "SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = 'correspondent.sandbox_webhook_secret'", { replacements: { c: tenant.companyId }, transaction: t },
))[0][0].n);

/** Caso enviado de verdade (commit): devolve o caso, a submissão e o id externo. */
async function casoEnviado() {
  let caso;
  await withTenantTransaction(tenant, async (t) => { caso = await env.casoPronto(t); });
  casos.push(caso.id);
  const submission = await withTenantTransaction(tenant, (t) => submissionsService.submitFinancingCase(caso.id, { consent: true, amount: 200000 }, ...env.a(), t));
  assert.equal(submission.status, 'SUBMITTED');
  return { caso, submission, externalCaseId: submission.externalCaseId };
}

function assinado(segredo, corpo) {
  const rawBody = Buffer.from(JSON.stringify(corpo));
  return { rawBody, headers: { 'x-webhook-signature': `sha256=${crypto.createHmac('sha256', segredo).update(rawBody).digest('hex')}` } };
}

const noBanco = (sql, replacements) => withTenantTransaction(tenant, async (t) => (await sequelize.query(sql, { replacements, transaction: t }))[0]);

test('financiamento_webhook_inbox_nova_tabela_dedup', async () => {
  const segredo = `wh-${uniqueSuffix()}`;
  await definirSegredo(segredo);
  const { submission, externalCaseId } = await casoEnviado();
  const corpo = { externalCaseId, externalEventId: `evt-d240-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const { rawBody, headers } = assinado(segredo, corpo);
  const primeiro = await webhooks.processFinancingWebhook('sandbox', rawBody, headers, corpo);
  assert.deepEqual([primeiro.processed, primeiro.applied], [true, true]);
  const segundo = await webhooks.processFinancingWebhook('sandbox', rawBody, headers, corpo);
  assert.deepEqual([segundo.processed, segundo.reason], [false, 'duplicate_event'], 'o duplicado nunca reaplica o efeito');
  const nova = await noBanco('SELECT * FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: 'sandbox', e: corpo.externalEventId });
  assert.equal(nova.length, 1, 'UNIQUE(fornecedor, id do evento) na caixa de entrada nova');
  const antiga = await noBanco('SELECT count(*)::int AS n FROM correspondent.webhook_inbox WHERE external_event_id = :e', { e: corpo.externalEventId });
  assert.equal(antiga[0].n, 0, 'nada novo na tabela antiga');
  // o status assinado pelo provider confirma o envio do caso (ON_STATUS), uma vez
  const envio = await noBanco("SELECT status, confirmed_at FROM integration.dispatches WHERE aggregate_type = 'ProviderSubmission' AND aggregate_id = :id", { id: submission.id });
  assert.equal(envio.length, 1);
  assert.equal(envio[0].status, 'CONFIRMED');
  assert.ok(envio[0].confirmed_at);
});

test('financiamento_rota_publica_legada_ativa', async () => {
  const segredo = `wh-${uniqueSuffix()}`;
  await definirSegredo(segredo);
  const { externalCaseId } = await casoEnviado();
  const corpo = { externalCaseId, externalEventId: `evt-http-${uniqueSuffix()}`, status: 'ANALYSIS' };
  const { rawBody, headers } = assinado(segredo, corpo);
  const url = `http://127.0.0.1:${process.env.PORT}/api/v1/correspondent/webhooks/financing/sandbox`;
  const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: rawBody });
  assert.equal(ok.status, 200, 'a rota pública antiga continua com o mesmo caminho e sem login');
  const resposta = await ok.json();
  assert.equal((resposta.data || resposta).processed, true);
  const gravado = await noBanco('SELECT 1 FROM integration.webhook_inbox WHERE provider_code = :p AND external_event_id = :e', { p: 'sandbox', e: corpo.externalEventId });
  assert.equal(gravado.length, 1, 'o evento da rota antiga entra na caixa de entrada do registro');
  const semAssinatura = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody });
  assert.equal(semAssinatura.status, 401);
});

test('m9_d240_segredo_lido_pelo_secretstore', async () => {
  const desligar = useTempSecretStore();
  try {
    const segredo = `wh-vault-${uniqueSuffix()}`;
    await definirSegredo(segredo);
    assert.equal(await segredoGuardado(), 1);
    const { externalCaseId } = await casoEnviado();
    // referência legada do Marco 8 (vault:...) na connection: a migração a normaliza para o formato do cofre
    await noBanco("UPDATE integration.connections SET secret_ref = 'vault:nayara/legado/fin' WHERE company_id = :c AND provider_code = 'financing-sandbox' AND status = 'ACTIVE'", { c: tenant.companyId });
    const corpo1 = { externalCaseId, externalEventId: `evt-v1-${uniqueSuffix()}`, status: 'ANALYSIS' };
    const r1 = await webhooks.processFinancingWebhook('sandbox', ...Object.values(assinado(segredo, corpo1)), corpo1);
    assert.equal(r1.processed, true, 'o primeiro webhook valida com o valor antigo e migra');
    assert.equal(await segredoGuardado(), 0, 'depois da migração o valor deixa de existir em tenant_settings');
    const connection = await withTenantTransaction(tenant, (t) => IntegrationConnection.findOne({ where: { companyId: tenant.companyId, providerCode: 'financing-sandbox', status: 'ACTIVE' }, order: [['created_at', 'ASC']], transaction: t })); // a mesma escolha do código
    assert.ok(connection.secretRef.startsWith(`company/${tenant.companyId}/financing/financing-sandbox`), 'a referência legada vault:... ficou no formato do cofre (única por connection)');
    const lido = await withTenantTransaction(tenant, (t) => readConnectionSecret(connection, tenant, { purpose: 'webhook', kind: 'webhook', transaction: t }));
    assert.equal(lido.value.reveal(), segredo, 'o webhook agora é lido pelo SecretStore (readConnectionSecret)');
    // o segundo webhook valida só pelo cofre; a migração é idempotente (não há mais o que migrar e nada se duplica)
    const corpo2 = { externalCaseId, externalEventId: `evt-v2-${uniqueSuffix()}`, status: 'APPROVED' };
    const r2 = await webhooks.processFinancingWebhook('sandbox', ...Object.values(assinado(segredo, corpo2)), corpo2);
    assert.equal(r2.processed, true);
    assert.equal(await segredoGuardado(), 0);
    // assinatura com outro segredo continua recusada
    const corpo3 = { externalCaseId, externalEventId: `evt-v3-${uniqueSuffix()}`, status: 'COMPLETED' };
    await assert.rejects(webhooks.processFinancingWebhook('sandbox', ...Object.values(assinado('segredo-errado', corpo3)), corpo3), (e) => e.code === 'CORRESPONDENT_WEBHOOK_HMAC_INVALID');
  } finally { desligar(); }
});
