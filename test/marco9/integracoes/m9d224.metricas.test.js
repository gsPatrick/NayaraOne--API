'use strict';

// Marco 9, M9-D224 — as 8 métricas do livro (9 valores) por connection e janela, e o painel/API que as expõem só para a empresa do usuário, sem segredo nem payload.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  sequelize, comTenant, carregarTenants, tenantCI, conexaoAtiva, limparCircuito, desativarConexoesDeTeste, envios, tentativas, inbox, forcarCircuito,
} = require('../_helpers/m9d224Env');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');
const { IntegrationConnection } = require('../../../src/models');
const { registerHealthSampleSource, resetHealthSampleSources } = require('../../../src/features/integrations/health/sampleSources');
const { dispatchHealthSample } = require('../../../src/features/integrations/dispatch/quota/quota.sample');
const { inboxHealthSample } = require('../../../src/features/integrations/health/inboxSample');
const { METRIC_KEYS, getWindowMetrics } = require('../../../src/features/integrations/health/metrics');

let tenant;
let env;

before(async () => {
  ({ tenant } = await carregarTenants());
  if (DISPOSABLE) {
    await grant('CI GESTOR', ['integration:read']);
    env = await startHttpEnv(Number(process.env.M9D224_HTTP_TEST_PORT) || 21724, [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]);
  }
  // o app já registrou as fontes no boot; registrar de novo é no-op (a mesma função não entra duas vezes)
  registerHealthSampleSource(dispatchHealthSample);
  registerHealthSampleSource(inboxHealthSample);
});
after(async () => {
  resetHealthSampleSources();
  await limparCircuito(tenant);
  await desativarConexoesDeTeste(tenant);
  if (env) {
    await desativarConexoesDeTeste(await tenantCI('A'));
    await desativarConexoesDeTeste(await tenantCI('B'));
    setTimeout(() => process.exit(0), 300);
  } else await sequelize.close();
});

const carregar = (id) => comTenant(tenant, (t) => IntegrationConnection.findByPk(id, { transaction: t }));

test('metricas_oito_indicadores_calculados', async () => {
  const c = await conexaoAtiva(tenant, 'MESSAGING');
  const agora = new Date();
  const ids = await envios(tenant, c.id, 4);
  // 10 sucessos de 100 a 1000 ms, 2 falhas transitórias, 1 de credencial e 1 limite do fornecedor (que o ritmo nosso causou, D225): 14 chamadas, 10 boas = 71,43%
  const boas = Array.from({ length: 10 }, (_, i) => ({ dispatchId: ids[0], outcome: 'SUCCESS', latencyMs: (i + 1) * 100, no: i < 2 ? 2 : 1 }));
  const ruins = [
    { dispatchId: ids[1], outcome: 'ERROR', errorClass: 'TRANSIENT', latencyMs: 1000 },
    { dispatchId: ids[1], outcome: 'ERROR', errorClass: 'TRANSIENT', latencyMs: 1000 },
    { dispatchId: ids[2], outcome: 'ERROR', errorClass: 'AUTH', latencyMs: 1000, quota: { limit: 1000, remaining: 250 } },
    // o limite do fornecedor também conta em rate_limit_count; erro de dado nosso fica fora das chamadas
    { dispatchId: ids[2], outcome: 'ERROR', errorClass: 'RATE_LIMIT', latencyMs: 40, rateLimited: true },
    { dispatchId: ids[3], outcome: 'ERROR', errorClass: 'VALIDATION', latencyMs: 30 },
  ];
  await tentativas(tenant, c, [...boas, ...ruins], agora);
  await comTenant(tenant, async (t) => {
    await sequelize.query("UPDATE integration.dispatches SET status = 'DEAD_LETTER' WHERE id = :id", { replacements: { id: ids[3] }, transaction: t });
    await sequelize.query("UPDATE integration.dispatches SET status = 'RETRY_WAIT', next_attempt_at = now() - interval '1 minute' WHERE id = :id", { replacements: { id: ids[2] }, transaction: t });
  });
  await inbox(tenant, c, 'RECEIVED', 2);
  await inbox(tenant, c, 'FAILED', 1);
  await inbox(tenant, c, 'DEAD_LETTER', 2);
  await inbox(tenant, c, 'PROCESSED', 3);
  const m = await comTenant(tenant, async (t) => getWindowMetrics(await IntegrationConnection.findByPk(c.id, { transaction: t }), '1h', new Date(), t));
  assert.deepEqual(Object.keys(m), METRIC_KEYS);
  assert.deepEqual(m, {
    successRate: 71.43, // 10 de 14 chamadas
    latencyP95Ms: 1000,
    latencyP99Ms: 1000,
    rateLimitCount: 1,
    authFailures: 1,
    retries: 2, // tentativas além da 1ª
    dlq: 3, // 1 envio + 2 eventos em DEAD_LETTER
    backlog: 6, // 2 envios PENDING + 1 RETRY_WAIT vencido + 2 eventos RECEIVED + 1 FAILED
    quotaRemaining: 250,
  }, 'os 9 valores da janela de 1 hora');
  const w5 = await comTenant(tenant, async (t) => getWindowMetrics(await carregar(c.id), '5m', new Date(), t));
  const w1d = await comTenant(tenant, async (t) => getWindowMetrics(await carregar(c.id), '1d', new Date(), t));
  assert.equal(w5.successRate, 71.43, 'as tentativas estão nos últimos minutos');
  assert.equal(w1d.successRate, 71.43);
  const antigas = await carregar(c.id);
  await tentativas(tenant, antigas, [{ dispatchId: ids[0], outcome: 'ERROR', errorClass: 'TRANSIENT', latencyMs: 10, minAtras: 600 }], agora);
  const w1h = await comTenant(tenant, async (t) => getWindowMetrics(await carregar(c.id), '1h', new Date(), t));
  const w1dDepois = await comTenant(tenant, async (t) => getWindowMetrics(await carregar(c.id), '1d', new Date(), t));
  assert.equal(w1h.successRate, 71.43, 'a falha de 10 h atrás fica fora da janela de 1 h');
  assert.equal(w1dDepois.successRate, Math.round((10 / 15) * 10000) / 100, 'e entra na de 1 dia');
  await assert.rejects(comTenant(tenant, async (t) => getWindowMetrics(await carregar(c.id), '2h', new Date(), t)), (e) => e.statusCode === 422);
});

test('metricas_oito_do_livro_em_nove_valores_expostas', { skip: SKIP }, async () => {
  assert.deepEqual(METRIC_KEYS, ['successRate', 'latencyP95Ms', 'latencyP99Ms', 'rateLimitCount', 'authFailures', 'retries', 'dlq', 'backlog', 'quotaRemaining'], 'lista exata e nomes');
  const livro = ['success_rate', 'latency p95', 'latency p99', 'rate_limit_count', 'auth_failures', 'retries', 'dlq', 'backlog', 'quota_remaining'];
  assert.equal(METRIC_KEYS.length, livro.length, 'as 8 métricas do livro em 9 valores (a latência tem p95 e p99)');
  const { call, tokens } = env;
  const tA = await tenantCI('A');
  const c = await conexaoAtiva(tA, 'MESSAGING');
  const r = await call('GET', '/admin/integrations?environment=SANDBOX', tokens['A:gestor']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const linha = r.body.data.items.find((x) => x.id === c.id);
  assert.ok(linha, 'a connection aparece no painel');
  assert.deepEqual(Object.keys(linha.metrics), METRIC_KEYS, 'a API expõe exatamente os 9 valores');
  for (const campo of ['provider', 'environment', 'circuitState', 'healthStatus', 'criticality', 'secretExpiresInDays', 'lastSyncAt', 'openAlerts']) assert.ok(campo in linha, `campo ${campo}`);
  assert.ok(r.body.data.items.every((x) => x.environment === 'SANDBOX'), 'filtro por ambiente');
});

test('painel_somente_empresa_do_usuario', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  const tA = await tenantCI('A');
  const tB = await tenantCI('B');
  const cA = await conexaoAtiva(tA, 'MESSAGING');
  const cB = await conexaoAtiva(tB, 'MESSAGING');
  const a = await call('GET', '/admin/integrations', tokens['A:gestor']);
  const b = await call('GET', '/admin/integrations', tokens['B:gestor']);
  const idsA = a.body.data.items.map((x) => x.id);
  const idsB = b.body.data.items.map((x) => x.id);
  assert.ok(idsA.includes(cA.id) && !idsA.includes(cB.id), 'A só vê a empresa A');
  assert.ok(idsB.includes(cB.id) && !idsB.includes(cA.id), 'B só vê a empresa B');
  assert.equal((await call('GET', '/admin/integrations', tokens['A:leitura'])).status, 403, 'sem integration:read');
  assert.equal((await call('GET', '/admin/integrations')).status, 401);
  const negado = await call('GET', '/admin/integrations', tokens['A:leitura']);
  assert.equal(negado.body.error.code, 'PERMISSION_DENIED');
});

test('painel_sem_segredo_nem_payload', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  const tA = await tenantCI('A');
  const c = await conexaoAtiva(tA, 'MESSAGING');
  const [id] = await envios(tA, c.id, 1, { to: '+5541999990000', text: 'SEGREDO-NAO-VAZAR-123' });
  await comTenant(tA, (t) => sequelize.query("UPDATE integration.dispatches SET status = 'DEAD_LETTER' WHERE id = :id", { replacements: { id }, transaction: t }));
  await comTenant(tA, (t) => sequelize.query("UPDATE integration.connections SET config_json = CAST(:cfg AS jsonb), secret_ref = 'nayara/prod/messaging/token-ABCD' WHERE id = :id", { replacements: { id: c.id, cfg: JSON.stringify({ baseUrl: 'https://x.exemplo.com.br', segredoNaConfig: 'CONFIG-NAO-VAZAR' }) }, transaction: t }).catch(() => null));
  await forcarCircuito(tA, c.id, { circuitState: 'CLOSED' });
  const r = await call('GET', '/admin/integrations', tokens['A:gestor']);
  const texto = JSON.stringify(r.body);
  for (const proibido of ['SEGREDO-NAO-VAZAR-123', 'CONFIG-NAO-VAZAR', 'nayara/prod/messaging/token-ABCD', 'payload_snapshot', 'payloadSnapshot', 'config_json', 'configJson', 'password', 'apiKey']) {
    assert.equal(texto.includes(proibido), false, `a resposta não pode conter ${proibido}`);
  }
  const alertas = await call('GET', '/admin/integrations/alerts', tokens['A:gestor']);
  assert.equal(alertas.status, 200, JSON.stringify(alertas.body));
  assert.equal(JSON.stringify(alertas.body).includes('SEGREDO-NAO-VAZAR-123'), false);
});
