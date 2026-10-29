'use strict';

// Marco 9, M9-D250 — POST /admin/integrations/:provider/test-connection (HTTP real, MFA real do usuário de teste). Testes 8, 9, 10, 11 e 15 da demanda e o critério
// acrescentado pela M9-D011 (provedor de IA). Roda em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D250_TESTE_PORT || '21753';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d250Env');
const secrets = require('../../../src/features/integrations/secrets');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');
const { programavel } = require('../_helpers/m9d214Scripted');
const { AnalyticsAdapter } = require('../../../src/features/integrations/providers/analytics/analytics.port');
const { MessagingAdapter } = require('../../../src/features/integrations/providers/messaging/messaging.port');
const { SignatureAdapter } = require('../../../src/features/integrations/providers/signature/signature.port');

const { carregarTenants, comTenant, ctxDe, sequelize } = env;
let tenant;
let chamar;
let tokenTeste;
let tokenGerencia;
const SEGREDO = 'SEGREDO-QA-M9-D250-abcdef';
const uniq = () => Math.random().toString(16).slice(2, 10);

before(async () => {
  ({ tenant } = await carregarTenants());
  secrets.setSecretStoreForTests(secrets.createHttpVaultStore({ mode: 'sandbox' }));
  tokenTeste = env.tokenDe(tenant, ['integration:read', 'integration:test']);
  tokenGerencia = env.tokenDe(tenant, ['integration:read', 'integration:test', 'integration:manage']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});
afterEach(async () => {
  env.restaurarAdaptadores();
  await env.config(tenant, 'integration.admin.test_connection_timeout_ms', 10000).catch(() => null);
});
after(async () => { secrets.setSecretStoreForTests(null); await env.admin().close(); await sequelize.close(); process.exit(0); });

const testar = (provider, body, token = tokenTeste) => chamar(token, 'POST', `/admin/integrations/${provider}/test-connection`, body);
const codigo = (r) => (r.corpo.error ? r.corpo.error.code : null);
const instalar = env.instalarTemporario;

/** Cria a connection do fornecedor no ambiente (SANDBOX; PRODUCTION muda o ambiente direto no banco para não depender do MFA de criação). */
async function conexao(providerCode, { ambiente = 'SANDBOX', secretRef, ativa = false } = {}) {
  const c = await comTenant(tenant, (t) => registry.createConnection({ providerCode, environment: 'SANDBOX', label: `QA-M9 ${uniq()}`, secretRef }, ctxDe(tenant), t));
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND environment = :e AND status IN ('ACTIVE', 'AUTH_FAILED', 'PAUSED', 'DRAFT') AND id <> :id", { c: tenant.companyId, p: providerCode, e: ambiente, id: c.id });
  if (ambiente !== 'SANDBOX') await env.sql(tenant, 'UPDATE integration.connections SET environment = :e, production_released_at = now() WHERE id = :id', { e: ambiente, id: c.id });
  if (ativa) await comTenant(tenant, (t) => transitionConnection(c.id, 'ACTIVE', ctxDe(tenant), t));
  return c;
}
const status = async (id) => (await env.sql(tenant, 'SELECT status FROM integration.connections WHERE id = :id', { id }))[0].status;

test('test_connection_nao_executa_operacao_mutavel', async () => {
  const Msg = programavel(MessagingAdapter, 'messaging-sandbox', ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']);
  let saude = 0;
  Msg.prototype.healthCheck = async () => { saude += 1; return { ok: true, latencyMs: 3, detail: 'ok' }; };
  instalar(Msg);
  const c = await conexao('messaging-sandbox', { ativa: true });
  const r = await testar('messaging-sandbox', { environment: 'SANDBOX', connectionId: c.id });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.data.ok, true);
  assert.equal(saude, 1, 'o healthCheck do adapter foi chamado');
  assert.deepEqual(Msg.S.chamadas, [], 'nenhuma mensagem foi enviada nem operação executada');

  // Consulta inócua marcada como safeProbe é executada; as operações que emitem dados, nunca.
  const Ana = programavel(AnalyticsAdapter, 'analytics-sandbox', ['emitMetric', 'emitEvent', 'queryHealth']);
  instalar(Ana);
  Ana.S.fila('queryHealth', [{ resposta: { status: 'ACCEPTED' } }]);
  await conexao('analytics-sandbox', { ativa: true });
  const a = await testar('analytics-sandbox', { environment: 'SANDBOX' });
  assert.equal(a.corpo.data.ok, true);
  assert.deepEqual(Ana.S.chamadas.map((x) => x.op), ['queryHealth'], 'só a leitura inócua');
  Ana.S.fila('queryHealth', [{ erro: new Error('fora do ar') }]);
  const ruim = await testar('analytics-sandbox', { environment: 'SANDBOX' });
  assert.equal(ruim.status, 200);
  assert.equal(ruim.corpo.data.ok, false, 'a leitura de teste que falha reprova a saúde');
  assert.deepEqual(ruim.corpo.data.checks.map((x) => [x.name, x.ok]), [['auth', true], ['tls', true], ['health', false]]);
});

test('test_connection_producao_exige_mfa', async () => {
  const c = await conexao('bank-sandbox', { ambiente: 'PRODUCTION' });
  await env.ativarMfa(tenant);
  await env.vencerMfa(tenant);
  const sem = await testar('bank-sandbox', { environment: 'PRODUCTION', connectionId: c.id });
  assert.equal(sem.status, 403);
  assert.equal(codigo(sem), 'MFA_STEP_UP_REQUIRED');
  assert.equal((await env.trilha(tenant, c.id, 'integration.connection.tested')).length, 0, 'recusa não audita teste');
  await env.ativarMfa(tenant);
  const com = await testar('bank-sandbox', { environment: 'PRODUCTION', connectionId: c.id });
  assert.equal(com.status, 200, 'com MFA recente o teste roda');
  assert.equal(com.corpo.data.checks.length, 3);
  // O administrador pode desligar a regra; fora de produção ela nunca vale.
  await env.vencerMfa(tenant);
  await env.config(tenant, 'integration.admin.mfa_on_prod_test_connection', false);
  assert.equal((await testar('bank-sandbox', { environment: 'PRODUCTION', connectionId: c.id })).status, 200);
  await env.config(tenant, 'integration.admin.mfa_on_prod_test_connection', true);
  const s = await conexao('email-sandbox');
  assert.equal((await testar('email-sandbox', { environment: 'SANDBOX', connectionId: s.id })).status, 200, 'sandbox não pede MFA');
});

test('test_connection_sem_segredo_na_resposta', async () => {
  const Clicksign = programavel(SignatureAdapter, 'signature-clicksign', ['createEnvelope', 'getEnvelope', 'cancelEnvelope', 'verifyWebhook']);
  Clicksign.prototype.healthCheck = async function saude() {
    const { value } = await this.ctx.secret('test-connection');
    return { ok: false, latencyMs: 4, detail: `Chave recusada: ${value.reveal()}` }; // o fornecedor ecoa a chave na mensagem
  };
  instalar(Clicksign);
  const ref = `company/${tenant.companyId}/qa-m9-d250/${uniq()}/api-key`;
  await secrets.getSecretStore().put(ref, SEGREDO, {});
  const c = await conexao('signature-clicksign', { secretRef: ref });
  const r = await testar('signature-clicksign', { environment: 'SANDBOX', connectionId: c.id });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.data.ok, false);
  const varredura = JSON.stringify(r.corpo);
  assert.ok(!varredura.includes(SEGREDO), 'a resposta não traz o valor da credencial');
  assert.ok(!varredura.includes(ref), 'nem a referência do cofre');
  assert.deepEqual(Object.keys(r.corpo.data).sort(), ['checks', 'latencyMs', 'message', 'ok']);
  const audit = JSON.stringify(await env.trilha(tenant, c.id, 'integration.connection.tested'));
  assert.ok(!audit.includes(SEGREDO) && !audit.includes(ref), 'a auditoria também não');
  assert.equal((await env.trilha(tenant, c.id, 'integration.connection.tested')).length, 1);
});

test('test_connection_reativa_auth_failed', async () => {
  const c = await conexao('bank-sandbox', { ativa: true });
  await comTenant(tenant, (t) => transitionConnection(c.id, 'AUTH_FAILED', ctxDe(tenant), t, { system: true }));
  assert.equal(await status(c.id), 'AUTH_FAILED');
  const semManage = await testar('bank-sandbox', { environment: 'SANDBOX', connectionId: c.id });
  assert.equal(semManage.corpo.data.ok, true);
  assert.equal(await status(c.id), 'AUTH_FAILED', 'sem integration:manage o teste verde não reativa');
  const com = await testar('bank-sandbox', { environment: 'SANDBOX', connectionId: c.id }, tokenGerencia);
  assert.equal(com.corpo.data.ok, true);
  assert.equal(com.corpo.data.reactivated, true);
  assert.equal(await status(c.id), 'ACTIVE', 'teste verde com integration:manage reativa');
  const [linha] = await env.trilha(tenant, c.id, 'integration.connection.tested');
  assert.ok(linha, 'o teste foi auditado');
  // Teste vermelho não reativa.
  const Banco = programavel(require('../../../src/features/integrations/providers/bank/bank.port').BankAdapter, 'bank-sandbox', ['submitPayment', 'getPaymentStatus', 'getStatement', 'verifyWebhook']);
  Banco.prototype.healthCheck = async () => ({ ok: false, latencyMs: 1, detail: 'recusado' });
  instalar(Banco);
  await comTenant(tenant, (t) => transitionConnection(c.id, 'AUTH_FAILED', ctxDe(tenant), t, { system: true }));
  const ruim = await testar('bank-sandbox', { environment: 'SANDBOX', connectionId: c.id }, tokenGerencia);
  assert.equal(ruim.corpo.data.ok, false);
  assert.equal(await status(c.id), 'AUTH_FAILED');
  await comTenant(tenant, (t) => env.sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE id = :id", { replacements: { id: c.id }, transaction: t }));
});

test('test_connection_falha_devolve_200_ok_false', async () => {
  const sem = await conexao('anthropic');
  const r = await testar('anthropic', { environment: 'SANDBOX', connectionId: sem.id });
  assert.equal(r.status, 200, 'nunca 500 nem o 400 de ativação');
  assert.equal(r.corpo.data.ok, false);
  assert.equal(r.corpo.data.checks.find((x) => x.name === 'auth').ok, false);
  assert.match(r.corpo.data.message, /credencial/i, 'motivo em português');
  const ref = `company/${tenant.companyId}/qa-m9-d250/${uniq()}/ausente`;
  const semValor = await conexao('openai', { secretRef: ref });
  const r2 = await testar('openai', { environment: 'SANDBOX', connectionId: semValor.id });
  assert.equal(r2.status, 200);
  assert.equal(r2.corpo.data.ok, false);
  assert.ok(!JSON.stringify(r2.corpo).includes(ref));
  // O provedor de IA de testes responde ok sem rede, pelo healthCheck do adapter.
  const sandbox = await conexao('ai-sandbox');
  const ok = await testar('ai-sandbox', { environment: 'SANDBOX', connectionId: sandbox.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.corpo.data.ok, true);
  assert.deepEqual(ok.corpo.data.checks.map((x) => x.ok), [true, true, true]);
});

test('test_connection_tempo_maximo_e_validacoes', async () => {
  const Msg = programavel(MessagingAdapter, 'messaging-sandbox', ['sendText', 'sendTemplate', 'sendMedia', 'getStatus']);
  Msg.prototype.healthCheck = () => new Promise((resolve) => { setTimeout(() => resolve({ ok: true, latencyMs: 1, detail: 'ok' }), 5000); });
  instalar(Msg);
  const c = await conexao('messaging-sandbox', { ativa: true });
  await env.config(tenant, 'integration.admin.test_connection_timeout_ms', 1000);
  const inicio = Date.now();
  const lento = await testar('messaging-sandbox', { environment: 'SANDBOX', connectionId: c.id });
  assert.equal(lento.status, 200);
  assert.equal(lento.corpo.data.ok, false, 'passou do tempo do teste: ok:false');
  assert.ok(Date.now() - inicio < 4000, 'não espera o fornecedor responder');
  assert.equal((await testar('messaging-sandbox', { environment: 'NUVEM' })).status, 422);
  assert.equal((await testar('messaging-sandbox', { environment: 'SANDBOX', connectionId: 'x' })).status, 422);
  assert.equal((await testar('fornecedor-que-nao-existe', { environment: 'SANDBOX' })).status, 404);
  const sem = await chamar(env.tokenDe(tenant, ['integration:read']), 'POST', '/admin/integrations/messaging-sandbox/test-connection', { environment: 'SANDBOX' });
  assert.equal(sem.status, 403);
  assert.equal(codigo(sem), 'PERMISSION_DENIED');
  const { outro } = await carregarTenants();
  if (outro) assert.equal((await testar('messaging-sandbox', { environment: 'SANDBOX', connectionId: c.id }, env.tokenDe(outro, ['integration:test']))).status, 404, 'connection de outra empresa não existe');
});
