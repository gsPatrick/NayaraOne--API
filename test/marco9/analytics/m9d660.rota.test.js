'use strict';

// M9-D660 — GET /v1/analytics/metrics/<código> dos quatro KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre
// empresas; recusas; detalhe (drill-down) dos dois KPIs CRITICAL cuja contagem bate com o valor.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d660Scenario');
const oracle = require('../_helpers/m9d660Oracle');
const registry = require('../../../src/features/analytics/metrics');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { materializeLegalKpis } = require('../../../src/features/analytics/metrics/kpis');
const clock = require('../../../src/features/analytics/metrics/clock');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const AS_OF = bi.AS_OF;
const READ = ['analytics:read'];
const CODES = ['legal.deadlines', 'legal.cases_by_risk', 'legal.values', 'legal.missing_documents'];
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  const ids = await sc.tudo(src, t);
  for (const c of [ids.reqs.c1, ids.reqs.c2]) await bi.update(src, 'legal.contracts', c, { starts_at: sc.at('11-01') });
  for (const [type, payload] of [['legal.deadline.created', {}], ['legal.case.updated', {}], ['legal.contract_requirement.updated', {}]]) await bi.apply(t, bi.makeEvent(t, type, { id: bi.uuid(), ...payload }));
  await http.inTx(t, { commit: true }, (tx) => materializeLegalKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId, codes: CODES };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c AND metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes))', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c AND metric_code IN (:codes)', { replacements: ids, transaction });
    for (const m of bi.MODELS || ['rm_legal_deadlines', 'rm_legal_cases_risk', 'rm_legal_values', 'rm_legal_missing_docs']) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
  });
  await http.teardown(env);
});

const get = (code, { perms = READ, tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code, unit, nature, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], [unit, 'OK', 1, code, nature]);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d660 GET /analytics/metrics/legal.deadlines devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('legal.deadlines')).body.data;
  assert.equal(Number(d.value), (await oracle.deadlinesFromSource(src, env.tenantA, AS_OF)).total);
  shape(d, 'legal.deadlines', 'COUNT', 'ACTUAL', 'legal.legal_deadlines');
});

test('m9d660 GET /analytics/metrics/legal.cases_by_risk devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('legal.cases_by_risk')).body.data;
  assert.equal(Number(d.value), (await oracle.casesFromSource(src, env.tenantA)).total);
  shape(d, 'legal.cases_by_risk', 'COUNT', 'ACTUAL', 'legal.legal_cases');
});

test('m9d660 GET /analytics/metrics/legal.values devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('legal.values')).body.data;
  assert.equal(money.cmp(d.value, (await oracle.casesFromSource(src, env.tenantA)).estimated), 0);
  shape(d, 'legal.values', 'BRL', 'ESTIMATED', 'legal.legal_cases');
});

test('m9d660 GET /analytics/metrics/legal.missing_documents devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('legal.missing_documents')).body.data;
  assert.equal(Number(d.value), (await oracle.missingFromSource(src, env.tenantA)).requirements);
  shape(d, 'legal.missing_documents', 'COUNT', 'ACTUAL', 'legal.contract_requirements');
});

test('m9d660 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  const mine = Number((await get('legal.deadlines')).body.data.value);
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    const asB = await get(code, { tenant: 'B' });
    assert.notEqual(asB.status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
  assert.ok(mine > 0);
});

test('m9d660 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('legal.deadlines', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('legal.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('legal.deadlines', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

for (const code of ['legal.deadlines', 'legal.cases_by_risk']) {
  test(`m9d660 ${code} (CRITICAL) tem especificação de origem e detalhe paginado cuja contagem bate com o valor do KPI`, async () => {
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
    const kpi = (await get(code)).body.data;
    const ref = kpi.sourceRefs[0];
    await http.inTx(env.tenantA, {}, async (tx) => {
      const ctx = { ...http.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'legal:read']) };
      const rows = [];
      let page = 1;
      let body;
      do {
        body = await openDrilldown(ctx, { metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
        rows.push(...body.rows);
        page += 1;
      } while (page <= body.totalPages);
      assert.equal(body.reconcileMode, 'COUNT');
      assert.equal(rows.length, Number(kpi.value), 'as páginas juntas devolvem as linhas que somam o KPI');
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    });
  });
}
