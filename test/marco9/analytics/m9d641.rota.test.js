'use strict';

// M9-D641 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas; detalhe
// (drill-down) dos KPIs CRITICAL cuja contagem bate com o valor; replay do mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const { limparMaterializacoes } = require('../_helpers/analyticsResiduo');
const kit = require('../_helpers/m9d641Env');
const sc = require('../_helpers/m9d641Scenario');
const oracle = require('../_helpers/m9d641Oracle');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { materializeRentalDeadlineKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, CODES, MODELS } = { ...kit };
const READ = ['analytics:read', 'legal:read']; // M9-D702: a rota de métrica confere também a permissão do domínio (M9-D700)
let env;
let src;
before(async () => {
  env = await http.setup();
  await limparMaterializacoes(env.admin, env.tenantA.companyId); // parte de um estado limpo: outros arquivos no mesmo banco deixam read models da agenda para esta empresa
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  await sc.garantias(src, t);
  await sc.obrigacoes(src, t);
  await sc.vistoriasChaves(src, t);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeRentalDeadlineKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
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
const shape = (d, code, table) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], ['COUNT', 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, table);
};

test('m9d641 GET /analytics/metrics/rent.guarantees_expiring devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.guarantees_expiring')).body.data;
  assert.equal(Number(d.value), (await oracle.guaranteesFromSource(src, env.tenantA, AS_OF)).in30);
  shape(d, 'rent.guarantees_expiring', 'legal.guarantees');
});

test('m9d641 GET /analytics/metrics/rent.obligations_pending devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.obligations_pending')).body.data;
  assert.equal(Number(d.value), (await oracle.obligationsFromSource(src, env.tenantA, AS_OF)).open);
  shape(d, 'rent.obligations_pending', 'legal.contract_requirements');
});

test('m9d641 GET /analytics/metrics/rent.inspections_keys devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.inspections_keys')).body.data;
  assert.equal(Number(d.value), (await oracle.inspectionsKeysFromSource(src, env.tenantA, AS_OF)).pending);
  shape(d, 'rent.inspections_keys', 'legal.inspections');
});

test('m9d641 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d641 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('rent.inspections_keys', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const missing = await get('rent.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('rent.inspections_keys', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

for (const code of ['rent.guarantees_expiring', 'rent.inspections_keys']) {
  test(`m9d641 ${code} (CRITICAL) tem especificação de origem e detalhe paginado cuja contagem bate com o valor do KPI`, async () => {
    const kpi = (await get(code)).body.data;
    const ref = kpi.sourceRefs[0];
    await http.inTx(env.tenantA, {}, async (tx) => {
      const ctx = http.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'legal:read']);
      const rows = [];
      let page = 1;
      let body;
      do {
        body = await openDrilldown(ctx, { metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
        rows.push(...body.rows);
        page += 1;
      } while (page <= body.totalPages);
      assert.equal(body.reconcileMode, 'COUNT');
      assert.equal(rows.length, Number(kpi.value));
      assert.ok(rows.length > 0);
    });
  });
}

test('m9d641 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  const cases = [['legal.guarantee.created', 'rm_rental_guarantees'], ['legal.contract.status_changed', 'rm_rental_obligations'], ['legal.inspection.completed', 'rm_rental_inspections_keys']];
  for (const [type, model] of cases) {
    const event = bi.makeEvent(t, type, { id: bi.uuid() });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3, 4`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('rent.guarantees_expiring')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeRentalDeadlineKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('rent.guarantees_expiring')).body.data.value, before);
});
