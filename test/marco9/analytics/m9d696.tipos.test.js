'use strict';

// M9-D696 — os tipos de check sobre um read model de teste: duplicidade, freshness (STALE x EXPIRED), faixa de linhas, erro do próprio check
// e o efeito BLOCK/WARN no dataset. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../_helpers/m9d696Generic');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { quality, NOW } = g;
const { types } = quality;
let env;
let tenant;
let explode = false; // liga o check que falha ao consultar

before(async () => {
  env = await g.setup();
  tenant = env.tenantA;
  const table = env.model;
  quality.registerChecks(env.model, [
    types.duplication({ code: 'dup_contas', metrics: ['fin.free_cash'], measure: async (ctx) => quality.sql.duplicates(ctx, ['account_id']) }),
    types.freshness({ code: 'frescor', domain: 'FINANCE', metrics: ['fin.free_cash'] }),
    types.rowCountRange({ code: 'faixa_linhas', metrics: ['fin.free_cash'], sourceCount: async (ctx) => quality.sql.count(ctx, `SELECT count(*) AS n FROM analytics.${env.source} WHERE company_id = :companyId`) }),
    types.invariant({ code: 'erro_proposital', metrics: ['fin.free_cash'], evaluate: async () => { if (explode) throw new Error(`falha de consulta em ${table}`); return { ok: true, expected: {}, observed: {} }; } }),
  ]);
});
after(() => g.teardown(env));

const setParam = (key, value) => g.inTx(tenant, { commit: true }, (tx) => upsertSetting(key, value, tenant, tenant.userId, tx));
const clearParams = () => env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.qualidade.%' OR key LIKE 'analytics.freshness.%'");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000);
const reset = async () => { await g.clearModel(env, tenant); await clearParams(); };

test('m9d696 duplicidade de evento aplicado é detectada', async () => {
  await reset();
  await g.addSource(env, tenant, 'caixa', '10.00');
  await g.addModelRow(env, tenant, 'caixa', '10.00');
  await g.seedHistory(env, tenant, [1, 1, 1]);
  const ok = await g.refresh(env, tenant, { rows: 1 });
  assert.equal(g.statusOf(ok, 'dup_contas').status, 'PASSED');

  await g.addModelRow(env, tenant, 'caixa', '10.00'); // o mesmo agregado duas vezes
  const bad = await g.refresh(env, tenant, { rows: 1 });
  const dup = g.statusOf(bad, 'dup_contas');
  assert.equal(dup.status, 'FAILED');
  assert.equal(dup.severity, 'CRITICAL', 'duplicidade é BLOCK (gravado como CRITICAL)');
  assert.equal(dup.checkType, 'DUPLICATION');
  assert.equal(dup.observed.duplicates, 1, 'com 1 duplicata já falha');
  assert.equal(bad.degraded, true);
});

test('m9d696 freshness STALE gera WARN e EXPIRED gera BLOCK', async () => {
  await reset();
  await g.addSource(env, tenant, 'caixa', '10.00');
  const run = async (ageMinutes) => {
    await g.clearModel(env, tenant);
    await g.addModelRow(env, tenant, 'caixa', '10.00', minutesAgo(ageMinutes));
    return g.refresh(env, tenant, { rows: 1 });
  };
  const fresh = await run(20);
  assert.equal(g.statusOf(fresh, 'frescor').status, 'PASSED', 'FINANCE: 20 min, limite 60');

  const stale = await run(180);
  const s = g.statusOf(stale, 'frescor');
  assert.deepEqual([s.status, s.severity, s.observed.state, s.observed.ageMinutes], ['FAILED', 'WARNING', 'STALE', 180]);
  assert.equal(stale.degraded, false, 'STALE só avisa (WARN)');
  assert.equal((await g.refreshStatus(env, stale.refreshId)).status, 'SUCCEEDED');

  const expired = await run(300);
  const e = g.statusOf(expired, 'frescor');
  assert.deepEqual([e.status, e.severity, e.observed.state], ['FAILED', 'CRITICAL', 'EXPIRED']);
  assert.equal(expired.degraded, true, 'EXPIRED é BLOCK (limite 60 x fator 4 = 240 min)');
  assert.equal((await g.refreshStatus(env, expired.refreshId)).status, 'DEGRADED');

  await setParam('analytics.freshness.max_minutos.FINANCE', 100);
  const custom = g.statusOf(await run(300), 'frescor');
  assert.deepEqual([custom.observed.state, custom.observed.limitMinutes], ['STALE', 100], 'o limite do domínio é parâmetro: 300 min com limite 100 (expira acima de 400)');
  assert.equal(g.statusOf(await run(450), 'frescor').observed.state, 'EXPIRED', '450 > 4 x 100');
  await setParam('analytics.freshness.fator_expirado', 6);
  assert.equal(g.statusOf(await run(450), 'frescor').observed.state, 'STALE', 'fator 6: expira só acima de 600 min');
  await setParam('analytics.qualidade.severidades', 'FRESHNESS_STALE=BLOCK');
  const asBlock = await run(450);
  assert.deepEqual([g.statusOf(asBlock, 'frescor').severity, asBlock.degraded], ['CRITICAL', true], 'a severidade é parâmetro');
});

test('m9d696 faixa de linhas detecta refresh vazio', async () => {
  await reset();
  await g.clearHistory(env);
  await g.addSource(env, tenant, 'caixa', '10.00');
  await g.addModelRow(env, tenant, 'caixa', '10.00');
  await g.seedHistory(env, tenant, [900, 900, 900, 900, 900, 900, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
  const at = async (rows) => {
    const out = await g.refresh(env, tenant, { rows });
    await g.dropRefresh(env, out.refreshId); // o refresh do teste não entra na média das chamadas seguintes
    return g.statusOf(out, 'faixa_linhas');
  };

  const empty = await at(0);
  assert.deepEqual([empty.status, empty.severity], ['FAILED', 'CRITICAL'], 'média 200, refresh com 0 linhas e fonte populada');
  assert.equal(empty.observed.rows, 0);
  assert.deepEqual([empty.expected.min, empty.expected.max], [100, 300], 'só os últimos 14 refreshes, +-50%');
  assert.equal((await at(100)).status, 'PASSED', 'limite inferior inclusivo');
  assert.equal((await at(300)).status, 'PASSED', 'limite superior inclusivo');
  assert.equal((await at(99)).status, 'FAILED');
  assert.equal((await at(301)).status, 'FAILED');

  await setParam('analytics.qualidade.faixa_contagem_pct', 100);
  assert.equal((await at(399)).status, 'PASSED', 'a faixa é parâmetro: +-100% vai a 400');
  await clearParams();
  await setParam('analytics.qualidade.janela_refreshes', 3);
  await g.seedHistory(env, tenant, [1000, 1000, 1000]);
  assert.equal((await at(300)).status, 'FAILED', 'janela de 3 refreshes: a média passou a ser 1000');
  assert.equal((await at(1000)).status, 'PASSED');
  await clearParams();
  assert.equal((await at(1000)).status, 'FAILED', 'janela padrão (14): média ~ 357, faixa 178 a 535');
  await g.addSource(env, tenant, 'banco', '1.00');
  const none = await g.refresh(env, tenant, { rows: 0 });
  await g.dropRefresh(env, none.refreshId);
  assert.equal(g.statusOf(none, 'faixa_linhas').status, 'FAILED', 'continua falha: a fonte tem dados');
});

test('m9d696 erro no check marca DEGRADED por precaução', async () => {
  await reset();
  await g.addModelRow(env, tenant, 'caixa', '10.00');
  explode = true;
  const out = await g.refresh(env, tenant, { rows: 1 });
  explode = false;
  const bad = g.statusOf(out, 'erro_proposital');
  assert.equal(bad.status, 'ERROR');
  assert.equal(bad.observed.code, 'ANALYTICS_QUALITY_CHECK_ERROR');
  assert.equal(bad.observed.message, 'Não foi possível verificar a qualidade; o indicador foi marcado como degradado.');
  assert.equal(out.degraded, true);
  assert.equal((await g.refreshStatus(env, out.refreshId)).status, 'DEGRADED');
  assert.ok(out.results.length >= 4, 'a falha de um check não aborta os outros');
  assert.equal(g.statusOf(out, 'frescor').status, 'PASSED');
  const saved = (await g.savedChecks(env, tenant)).filter((r) => r.check_code === 'erro_proposital');
  assert.ok(saved.length >= 1 && saved.every((r) => r.status === 'ERROR'), 'o erro fica registrado em data_quality_checks');
  const state = await g.inTx(tenant, {}, (tx) => quality.datasetQuality(env.model, { companyId: tenant.companyId, groupId: tenant.groupId }, tx));
  assert.equal(state.status, 'DEGRADED');
  assert.ok(state.degradedBy.includes('erro_proposital'));
});

test('m9d696 repetir o check grava nova linha e não altera a anterior', async () => {
  await reset();
  await g.addModelRow(env, tenant, 'caixa', '10.00');
  const first = await g.refresh(env, tenant, { rows: 1 });
  const rows1 = (await g.savedChecks(env, tenant)).filter((r) => r.refresh_id === first.refreshId);
  const second = await g.refresh(env, tenant, { rows: 1 });
  const all = await g.savedChecks(env, tenant);
  assert.deepEqual(all.filter((r) => r.refresh_id === first.refreshId).map((r) => r.id), rows1.map((r) => r.id));
  assert.equal(all.filter((r) => r.refresh_id === second.refreshId).length, rows1.length);
});
