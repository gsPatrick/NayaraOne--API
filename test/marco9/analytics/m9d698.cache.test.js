'use strict';

// M9-D698 (3.3) — cache de resposta por permissão e escopo: chave com painel, empresa, período, versão e hash das permissões efetivas;
// TTL em parâmetro; invalidação pelo evento analytics.read_model.refreshed da empresa; falha do cache cai na leitura direta. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const env615 = require('../_helpers/m9d615Env');
const clock = require('../../../src/features/analytics/metrics/clock');
const dashboards = require('../../../src/features/analytics/dashboards');
const readModels = require('../../../src/features/analytics/read-models');
const { flushBatch } = require('../../../src/features/analytics/read-models/readModel.batch');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let env;
let fin;
const T0 = new Date('2026-10-28T15:00:00Z');
before(async () => { env = await sup.setup(); fin = await env615.setup(); clock.setClock(() => T0); });
after(async () => { clock.resetClock(); dashboards.clearCache(); await env.admin.query("DELETE FROM core.tenant_settings WHERE key = 'analytics.cache.ttl_segundos'"); await env615.teardown(fin); await sup.teardown(env); });

const userA = (t) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: new Set(['analytics:read', 'finance:read', 'analytics:drilldown']) });
const userB = (t) => ({ ...userA(t), permissions: new Set(['analytics:read', 'finance:read']) });
const spec = { dashboardCode: 'finance', period: '2026-10', version: 1 };

function counter(prefix) {
  const calls = [];
  const compute = async (ctx) => { calls.push(ctx); return `${prefix}:${ctx.permissions.has('analytics:drilldown') ? 'restrito-visivel' : 'restrito-mascarado'}`; };
  return { calls, compute };
}

test('m9d698 cache não vaza entre usuários de permissões diferentes', async () => {
  dashboards.clearCache();
  const { calls, compute } = counter('painel');
  const a = await dashboards.cached(userA(env.tenantA), spec, compute);
  assert.equal(a, 'painel:restrito-visivel');
  const b = await dashboards.cached(userB(env.tenantA), spec, compute);
  assert.equal(b, 'painel:restrito-mascarado', 'B nunca recebe a resposta de A');
  assert.equal(calls.length, 2, 'cada conjunto de permissões calcula a sua resposta');
  assert.equal(await dashboards.cached(userA(env.tenantA), spec, compute), a);
  assert.equal(await dashboards.cached(userB(env.tenantA), spec, compute), b);
  assert.equal(calls.length, 2, 'a repetição de cada um vem do cache');

  const keyA = dashboards.buildDashboardCacheKey(userA(env.tenantA), spec);
  const keyB = dashboards.buildDashboardCacheKey(userB(env.tenantA), spec);
  assert.notEqual(keyA, keyB);
  for (const part of ['finance', env.tenantA.companyId, '2026-10']) assert.ok(keyA.includes(part), `a chave não traz ${part}: ${keyA}`);
  assert.notEqual(keyA, dashboards.buildDashboardCacheKey(userA(env.tenantA), { ...spec, version: 2 }), 'versão do painel faz parte da chave');
  assert.notEqual(keyA, dashboards.buildDashboardCacheKey(userA(env.tenantA), { ...spec, period: '2026-09' }), 'período faz parte da chave');
  assert.notEqual(keyA, dashboards.buildDashboardCacheKey(userA(env.tenantB), spec), 'empresa faz parte da chave');
  assert.equal(keyA, dashboards.buildDashboardCacheKey({ ...userA(env.tenantA), permissions: ['analytics:drilldown', 'finance:read', 'analytics:read'] }, spec), 'a ordem das permissões não muda a chave');
});

test('m9d698 mudança de permissão invalida chave de cache', async () => {
  dashboards.clearCache();
  const { calls, compute } = counter('abac');
  const before1 = userB(env.tenantA);
  await dashboards.cached(before1, spec, compute);
  await dashboards.cached(before1, spec, compute);
  assert.equal(calls.length, 1);
  const granted = { ...before1, permissions: new Set([...before1.permissions, 'analytics:drilldown']) }; // o usuário ganhou o detalhe
  assert.notEqual(dashboards.buildDashboardCacheKey(before1, spec), dashboards.buildDashboardCacheKey(granted, spec));
  assert.equal(await dashboards.cached(granted, spec, compute), 'abac:restrito-visivel', 'o cache antigo não serve para a permissão nova');
  assert.equal(calls.length, 2);
  const revoked = { ...before1, permissions: new Set(['analytics:read']) };
  await dashboards.cached(revoked, spec, compute);
  assert.equal(calls.length, 3, 'perder permissão também troca a chave');
});

test('m9d698 evento de refresh invalida o cache da empresa', async () => {
  dashboards.clearCache();
  const { calls, compute } = counter('refresh');
  await dashboards.cached(userA(env.tenantA), spec, compute);
  await dashboards.cached(userA(env.tenantB), spec, compute);
  assert.equal(calls.length, 2);

  // Refresh REAL da empresa A (worker + fim de lote), com commit: a invalidação acontece depois do commit.
  const entry = await env615.ledger.entry(fin, env.tenantA, { nature: 'PAYABLE', amount: '10.00', status: 'PENDING', due: '2026-11-05T15:00:00Z' });
  const event = env615.makeEvent(env.tenantA, 'finance.entry.created', { id: entry, competenceMonth: '2026-10' });
  await env615.inTx(env.tenantA, { commit: false }, async (tx) => {
    await readModels.applyEvent(event, tx, { now: T0 });
    await flushBatch(tx, { now: T0 });
  });
  await dashboards.cached(userA(env.tenantA), spec, compute);
  assert.equal(calls.length, 2, 'transação desfeita: o refresh não existiu e o cache segue valendo');

  await env615.inTx(env.tenantA, { commit: true }, async (tx) => {
    await readModels.applyEvent({ ...event, id: require('node:crypto').randomUUID() }, tx, { now: T0 });
    await flushBatch(tx, { now: T0 });
    await dashboards.cached(userA(env.tenantA), spec, compute);
    assert.equal(calls.length, 2, 'antes do commit o cache ainda vale (a invalidação espera o commit)');
  });
  await dashboards.cached(userA(env.tenantA), spec, compute);
  assert.equal(calls.length, 3, 'depois do commit a empresa A recalcula');
  await dashboards.cached(userA(env.tenantB), spec, compute);
  assert.equal(calls.length, 3, 'a empresa B não foi invalidada');
});

test('m9d698 TTL padrão de 60 segundos e parâmetro da empresa', async () => {
  dashboards.clearCache();
  const { calls, compute } = counter('ttl');
  const ctx = userA(env.tenantA);
  await dashboards.cached(ctx, spec, compute);
  clock.setClock(() => new Date(T0.getTime() + 59000));
  await dashboards.cached(ctx, spec, compute);
  assert.equal(calls.length, 1, 'aos 59 s ainda vale');
  clock.setClock(() => new Date(T0.getTime() + 61000));
  await dashboards.cached(ctx, spec, compute);
  assert.equal(calls.length, 2, 'aos 61 s venceu');

  await env615.inTx(env.tenantA, { commit: true }, (tx) => upsertSetting('analytics.cache.ttl_segundos', 5, env.tenantA, env.tenantA.userId, tx));
  dashboards.clearCache();
  clock.setClock(() => T0);
  const viaParam = () => env615.inTx(env.tenantA, {}, (tx) => dashboards.cached(ctx, spec, compute, { transaction: tx }));
  await viaParam();
  clock.setClock(() => new Date(T0.getTime() + 6000));
  await viaParam();
  assert.equal(calls.length, 4, 'com TTL de 5 s a entrada venceu aos 6 s');
  clock.setClock(() => T0);
});

test('m9d698 falha do cache degrada para a leitura direta', async () => {
  dashboards.clearCache();
  const { calls, compute } = counter('falha');
  const broken = { get() { throw new Error('cache fora do ar'); }, set() { throw new Error('cache fora do ar'); }, deleteCompany() {}, clear() {} };
  dashboards.setCacheStore(broken);
  try {
    assert.equal(await dashboards.cached(userA(env.tenantA), spec, compute), 'falha:restrito-visivel');
    assert.equal(await dashboards.cached(userA(env.tenantA), spec, compute), 'falha:restrito-visivel');
    assert.equal(calls.length, 2, 'sem cache cada leitura calcula');
  } finally {
    dashboards.setCacheStore(null);
  }
});

test('m9d698 GET de painel usa o cache e o cache respeita a permissão do painel', async () => {
  dashboards.clearCache();
  const before1 = dashboards.cacheStats();
  const ok = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:read', 'finance:read'] });
  assert.equal(ok.status, 200);
  const again = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:read', 'finance:read'] });
  assert.deepEqual(again.body.data, ok.body.data);
  const stats = dashboards.cacheStats();
  assert.equal(stats.hits - before1.hits, 1, 'a segunda abertura veio do cache');
  const denied = await env.call('GET', '/analytics/dashboards/finance', { perms: ['analytics:read'] });
  assert.equal(denied.status, 403, 'o cache não pula a conferência da permissão do painel');
});
