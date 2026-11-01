'use strict';

// M9-D640 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas; replay do
// mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const { limparMaterializacoes } = require('../_helpers/analyticsResiduo');
const kit = require('../_helpers/m9d640Env');
const sc = require('../_helpers/m9d640Scenario');
const oracle = require('../_helpers/m9d640Oracle');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const clock = require('../../../src/features/analytics/metrics/clock');
const { materializeRentalPortfolioKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, CODES, MODELS } = { ...kit };
const READ = ['analytics:read', 'legal:read', 'finance:read', 'properties:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
const same = (a, b) => assert.equal(money.cmp(a, b), 0, `${a} x ${b}`);
let env;
let src;
before(async () => {
  env = await http.setup();
  await limparMaterializacoes(env.admin, env.tenantA.companyId); // parte de um estado limpo: outros arquivos no mesmo banco deixam read models da agenda para esta empresa
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const cart = await sc.carteira(src, t);
  await sc.inadimplencia(src, t, cart);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeRentalPortfolioKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId };
  // o refresh da agenda liga os KPIs de todos os domínios: apaga o que eles publicaram para a empresa (definições, versões e snapshots)
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c)', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c', { replacements: ids, transaction });
    for (const m of MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id = :c`, { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d640 GET /analytics/metrics/rent.active_contracts devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const res = await get('rent.active_contracts');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(Number(d.value), (await oracle.activeFromSource(src, env.tenantA)).count);
  assert.equal(Number(d.value), 85);
  shape(d, 'rent.active_contracts', 'COUNT', 'legal.contracts');
  assert.equal(d.owner, 'Gerência de Locação (papel locação-gestor)');
});

test('m9d640 GET /analytics/metrics/rent.vacancy devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.vacancy')).body.data;
  same(d.value, (await oracle.vacancyFromSource(src, env.tenantA)).pct);
  same(d.value, '6.59');
  shape(d, 'rent.vacancy', 'PERCENT', 'real_estate.properties');
  assert.match(d.formatted, /%/);
});

test('m9d640 GET /analytics/metrics/rent.delinquency devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.delinquency')).body.data;
  same(d.value, (await oracle.delinquencyFromSource(src, env.tenantA, AS_OF)).rate);
  same(d.value, '4.10');
  shape(d, 'rent.delinquency', 'PERCENT', 'finance.financial_entries');
  assert.equal(d.drilldown.enabled, true);
});

test('m9d640 rent.delinquency nunca passa de fin.overdue_receivables (o recorte não excede o total) pela mesma rota', async () => {
  const [[fin]] = await env.admin.query('SELECT overdue_amount::text AS overdue FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: env.tenantA.companyId, d: AS_OF } });
  const dims = (await env.admin.query("SELECT s.value_numeric::text AS v FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code = 'rent.delinquency' AND s.dimension_key = 'vencido_brl' ORDER BY s.revision_no DESC LIMIT 1", { replacements: { c: env.tenantA.companyId } }))[0][0];
  assert.ok(money.cmp(dims.v, fin.overdue) <= 0, `${dims.v} <= ${fin.overdue}`);
});

test('m9d640 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d640 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('rent.delinquency', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('rent.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('rent.vacancy', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d640 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  const cases = [['legal.contract.status_changed', 'rm_rental_contracts'], ['property.updated', 'rm_rental_vacancy'], ['finance.entry.created', 'rm_rental_arrears']];
  for (const [type, model] of cases) {
    const event = bi.makeEvent(t, type, { id: bi.uuid() });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('rent.delinquency')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeRentalPortfolioKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('rent.delinquency')).body.data.value, before);
});
