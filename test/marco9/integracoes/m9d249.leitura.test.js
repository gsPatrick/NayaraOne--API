'use strict';

// Marco 9, M9-D249 — GET /v1/admin/integrations e GET /v1/admin/integrations/:provider/health (HTTP real, permissão real).
// Roda em banco descartável (grava linhas COMMITADAS).
process.env.PORT = process.env.M9D249_LEITURA_PORT || '21649';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');

const METRICAS = ['successRate', 'latencyP95Ms', 'latencyP99Ms', 'rateLimitCount', 'authFailures', 'retries', 'dlq', 'backlog', 'quotaRemaining'];
let tenants;
let tokenLeitura;
let tokenSem;
let tokenOutro;
let chamar;

before(async () => {
  tenants = await env.carregarTenants();
  tokenLeitura = env.tokenDe(tenants.tenant, ['integration:read']);
  tokenSem = env.tokenDe(tenants.tenant, ['settings:read']);
  tokenOutro = tenants.outro ? env.tokenDe(tenants.outro, ['integration:read']) : null;
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => { await env.sequelize.close(); process.exit(0); });

test('admin_get_integrations_lista_sem_segredos', async () => {
  const { tenant } = tenants;
  const c = await env.conexaoComSegredo(tenant, 'BANK', 'nayara/prod/bank/api-key', ", config_json = '{\"agencia\":\"0001\"}'::jsonb, secret_expires_at = now() + interval '14 days' - interval '1 hour'");
  const r = await chamar(tokenLeitura, 'GET', '/admin/integrations');
  assert.equal(r.status, 200);
  const item = r.corpo.data.items.find((i) => i.id === c.id);
  assert.ok(item, 'a connection da empresa aparece');
  assert.equal(item.provider, c.providerCode);
  assert.equal(item.domain, 'BANK');
  assert.equal(item.environment, 'SANDBOX');
  assert.equal(item.status, 'DRAFT');
  assert.equal(item.criticality, 'CRITICAL');
  assert.equal(item.circuitState, 'CLOSED');
  assert.ok(['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'].includes(item.healthStatus));
  assert.deepEqual(Object.keys(item.metrics).sort(), [...METRICAS].sort(), 'as 8 métricas do livro em 9 valores');
  assert.equal(item.secretExpiresInDays, 14);
  assert.equal(item.productionReleased, false);
  assert.equal(item.contingencyActive, false);
  assert.equal(item.secretRef, '…-key', 'só os últimos 4 caracteres');
  const bruto = JSON.stringify(r.corpo);
  assert.ok(!bruto.includes('nayara/prod/bank'), 'a referência completa do cofre nunca sai');
  assert.ok(!bruto.includes('agencia') && !/config_?json/i.test(bruto), 'a configuração da connection não sai');
  assert.match(item.createdAt, /-03:00$/, 'datas em ISO-8601 com fuso -03:00');

  const filtrada = await chamar(tokenLeitura, 'GET', '/admin/integrations?environment=SANDBOX&domain=BANK&status=DRAFT');
  assert.equal(filtrada.status, 200);
  assert.ok(filtrada.corpo.data.items.every((i) => i.domain === 'BANK' && i.status === 'DRAFT' && i.environment === 'SANDBOX'));
  assert.ok(filtrada.corpo.data.items.some((i) => i.id === c.id));
  const nenhuma = await chamar(tokenLeitura, 'GET', '/admin/integrations?environment=PRODUCTION&domain=BANK&status=DRAFT');
  assert.ok(!nenhuma.corpo.data.items.some((i) => i.id === c.id), 'o filtro de ambiente exclui');

  const sem = await chamar(tokenSem, 'GET', '/admin/integrations');
  assert.equal(sem.status, 403);
  assert.equal(sem.corpo.error.code, 'PERMISSION_DENIED');
  if (tokenOutro) {
    const outro = await chamar(tokenOutro, 'GET', '/admin/integrations');
    assert.ok(!outro.corpo.data.items.some((i) => i.id === c.id), 'outra empresa não enxerga a connection');
  }
});

test('admin_get_health_traz_slo_runbook', async () => {
  const { tenant } = tenants;
  const c = await env.conexaoComSegredo(tenant, 'SIGNATURE', 'nayara/prod/signature/token');
  const agora = Date.now();
  for (let i = 1; i <= 3; i += 1) {
    await env.janela(tenant, c, { minutos: 60, inicio: new Date(agora - i * 3600000), total: 100, sucesso: 100 - i, p95: 1000 + i, p99: 2000 + i, extras: { rate_limit_count: i } });
  }
  const r = await chamar(tokenLeitura, 'GET', `/admin/integrations/${c.providerCode}/health?window=1h`);
  assert.equal(r.status, 200);
  const d = r.corpo.data;
  assert.equal(d.provider, c.providerCode);
  assert.equal(d.window, '1h');
  assert.ok(d.series.length >= 3, 'série temporal das métricas');
  assert.deepEqual(Object.keys(d.series[0].metrics).sort(), [...METRICAS].sort());
  assert.ok(d.series[0].windowStart < d.series[d.series.length - 1].windowStart, 'série em ordem cronológica');
  assert.equal(d.circuit.state, 'CLOSED');
  assert.ok('limit' in d.quota && 'remaining' in d.quota && 'resetsAt' in d.quota);
  assert.ok('lastCheck' in d);
  assert.equal(d.slo.criticality, 'CRITICAL');
  assert.equal(d.slo.target.minSuccessRate, 99.9);
  assert.equal(d.slo.measured.callsTotal, 300);
  assert.equal(d.slo.measured.successRate, 98);
  assert.equal(d.slo.violated, true, '98% < 99,9%');
  assert.equal(d.runbookPath, `docs/runbooks/integrations/${c.providerCode}.md`);
  assert.match(d.series[0].windowStart, /-03:00$/);

  for (const w of ['5m', '1d', '30d']) assert.equal((await chamar(tokenLeitura, 'GET', `/admin/integrations/${c.providerCode}/health?window=${w}`)).status, 200, w);
  const semJanela = await chamar(tokenLeitura, 'GET', `/admin/integrations/${c.providerCode}/health`);
  assert.equal(semJanela.status, 200, 'sem window vale a janela de 1 h');
  assert.equal(semJanela.corpo.data.window, '1h');

  const naoTem = await chamar(tokenLeitura, 'GET', '/admin/integrations/fornecedor-que-a-empresa-nao-tem/health');
  assert.equal(naoTem.status, 404);
  assert.equal(naoTem.corpo.error.code, 'INTEGRATION_CONNECTION_NOT_FOUND');
  if (tokenOutro) {
    const outro = await chamar(tokenOutro, 'GET', `/admin/integrations/${c.providerCode}/health`);
    assert.equal(outro.status, 404, 'a outra empresa não tem o provider: 404, nunca 403');
  }
  assert.equal((await chamar(tokenSem, 'GET', `/admin/integrations/${c.providerCode}/health`)).status, 403);
});

test('admin_filtros_invalidos_422', async () => {
  const invalidos = [
    '/admin/integrations?environment=NUVEM',
    '/admin/integrations?domain=XYZ',
    '/admin/integrations?status=VOANDO',
    '/admin/integrations/bank-sandbox/health?window=2h',
    '/admin/integrations/bank-sandbox/health?environment=NUVEM',
    '/admin/integrations/errors?status=XYZ',
    '/admin/integrations/errors?limit=0',
    '/admin/integrations/errors?limit=201',
    '/admin/integrations/errors?limit=abc',
    '/admin/integrations/errors?cursor=isto-nao-e-cursor',
    '/admin/integrations/dispatches/nao-e-uuid',
  ];
  for (const caminho of invalidos) {
    const r = await chamar(tokenLeitura, 'GET', caminho);
    assert.equal(r.status, 422, caminho);
    assert.equal(r.corpo.error.code, 'VALIDATION_ERROR', caminho);
    assert.equal(r.corpo.error.message, 'Parâmetro de consulta inválido.', caminho);
  }
});
