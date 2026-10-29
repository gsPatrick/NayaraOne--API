'use strict';

// M9-D712 — tabela de criticidade das 90 métricas: completa, explícita, sem valor padrão e conferida contra o registry.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../../analytics.m9d603.support');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');

let env;
before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const globalDefinitions = async () => (await env.admin.query(
  'SELECT metric_code, criticality, drilldown_enabled, status, domain FROM analytics.metric_definitions WHERE company_id IS NULL AND group_id IS NULL ORDER BY metric_code'
))[0];

test('m9d712 toda metrica do registry tem criticidade explicita e esta na tabela', async () => {
  const rows = seed.listCriticalityRows();
  assert.equal(rows.length, 90);
  assert.equal(rows.filter((r) => r.criticality === 'CRITICAL').length, 33);
  assert.equal(rows.filter((r) => r.criticality === 'NORMAL').length, 57);
  const defs = await globalDefinitions();
  const diff = seed.compareWithTable(defs.map((d) => d.metric_code));
  assert.deepEqual(diff, { missing: [], extra: [] }, 'nenhuma sobra, nenhuma falta');
  for (const row of rows) {
    const def = defs.find((d) => d.metric_code === row.code);
    assert.equal(def.criticality, row.criticality, row.code);
    assert.equal(def.domain, row.domain, row.code);
    assert.equal(def.drilldown_enabled, row.criticality === 'CRITICAL', `${row.code}: CRITICAL liga o drill-down`);
  }
  assert.ok(rows.every((r) => ['CRITICAL', 'NORMAL'].includes(r.criticality) && r.reason && r.demand && r.name));
});

test('m9d712 todas as metricas do registry estao na tabela de criticidade', async () => {
  const diff = seed.compareWithTable([...(await globalDefinitions()).map((d) => d.metric_code), 'x.nova_sem_linha']);
  assert.deepEqual(diff.extra, ['x.nova_sem_linha'], 'a sobra é apontada');
  assert.deepEqual(seed.compareWithTable(seed.listCriticalityRows().slice(1).map((r) => r.code)).missing, [seed.listCriticalityRows()[0].code], 'a falta é apontada');
  const codes = seed.listCriticalityRows().map((r) => r.code);
  assert.equal(new Set(codes).size, 90, 'sem código repetido');
  for (const code of codes) assert.match(code, /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/);
});

test('m9d712 nenhuma metrica fica sem criticidade apos o seed', async () => {
  const [[col]] = await env.admin.query(
    "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'metric_definitions' AND column_name = 'criticality'"
  );
  assert.equal(col.is_nullable, 'NO', 'NOT NULL');
  assert.equal(col.column_default, null, 'sem valor padrão');
  await assert.rejects(
    () => env.admin.transaction((t) => env.admin.query(
      "INSERT INTO analytics.metric_definitions (metric_code, name, domain, group_scoped) VALUES ('fin.m9d712_sem_criticidade', 'x', 'FINANCE', false)", { transaction: t }
    )),
    (err) => (err.original || err).code === '23502', 'inserir sem criticidade é recusado pelo banco'
  );
  await assert.rejects(
    () => sup.inTx(env.tenantA, {}, async (tx) => { await sup.metrics.enableAnalyticsWriter(tx); return sup.metrics.createMetricDefinition({ scopeLevel: 'COMPANY', groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, metricCode: 'fin.m9d712_x', name: 'x', domain: 'FINANCE' }, sup.ctxOf(env.tenantA), tx); }),
    (err) => err.code === 'ANALYTICS_METRIC_INVALID', 'o serviço também exige a criticidade'
  );
  const defs = await globalDefinitions();
  assert.ok(defs.length >= 90 && defs.every((d) => ['CRITICAL', 'NORMAL'].includes(d.criticality)));
  const [[crit]] = await env.admin.query(
    "SELECT count(*)::int AS n FROM analytics.metric_definitions WHERE criticality = 'CRITICAL' AND NOT drilldown_enabled"
  );
  assert.equal(crit.n, 0, 'o banco impede CRITICAL sem drill-down (CHECK)');
});

test('m9d712 metrica nova fora da tabela reprova o CI', async () => {
  const input = sup.metricInput(env, { scopeLevel: 'GLOBAL', metricCode: 'fin.m9d712_nova_fora_da_tabela', criticality: 'NORMAL' });
  await assert.rejects(
    () => sup.inTx(env.tenantA, {}, (tx) => registry.publishMetric(input, sup.ctxOf(env.tenantA), tx, { catalog: registry.createFormulaCatalog(env.formulaDir) })),
    (err) => err.statusCode === 422 && err.code === 'ANALYTICS_METRIC_NOT_IN_CRITICALITY_TABLE'
  );
  assert.throws(() => seed.assertInCriticalityTable('fin.free_cash') || (() => { throw new Error('ok'); })(), /ok/);
  assert.deepEqual(seed.compareWithTable([...seed.listCriticalityRows().map((r) => r.code), 'fin.m9d712_nova_fora_da_tabela']).extra, ['fin.m9d712_nova_fora_da_tabela']);
});

test('m9d712 os itens do Centro de Comando so apontam para metricas CRITICAL ou alertas', async () => {
  const rows = seed.listCriticalityRows();
  const feeders = rows.filter((r) => /bloco \d/.test(r.reason));
  assert.ok(feeders.length >= 20, 'a tabela marca as origens dos blocos do Centro de Comando');
  assert.ok(feeders.every((r) => r.criticality === 'CRITICAL'), 'toda origem de item de bloco é CRITICAL');
  assert.ok(rows.filter((r) => r.criticality === 'NORMAL').every((r) => !/bloco \d/.test(r.reason)), 'NORMAL nunca alimenta bloco');
  assert.deepEqual(seed.criticalCodes().sort(), rows.filter((r) => r.criticality === 'CRITICAL').map((r) => r.code).sort());
});
