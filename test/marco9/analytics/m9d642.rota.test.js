'use strict';

// M9-D642 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas; recusas; origem
// registrada cuja contagem de detalhe bate com o valor; replay do mesmo evento (helper compartilhado assertReplayIdempotent da M9-D607).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const { limparMaterializacoes } = require('../_helpers/analyticsResiduo');
const kit = require('../_helpers/m9d642Env');
const sc = require('../_helpers/m9d642Scenario');
const oracle = require('../_helpers/m9d642Oracle');
const asserts = require('../_helpers/readModelAsserts');
const clock = require('../../../src/features/analytics/metrics/clock');
const { openSourceDetail } = require('../../../src/features/analytics/metrics');
const { materializeRentalCareKpis } = require('../../../src/features/analytics/metrics/kpis');

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
  await sc.chamados(src, t);
  await sc.satisfacao(src, t);
  await sc.repasses(src, t);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeRentalCareKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
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

test('m9d642 GET /analytics/metrics/rent.tickets devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.tickets')).body.data;
  assert.equal(Number(d.value), (await oracle.ticketsFromSource(src, env.tenantA, AS_OF)).open);
  shape(d, 'rent.tickets', 'COUNT', 'construction.maintenance_cases');
});

test('m9d642 GET /analytics/metrics/rent.satisfaction devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.satisfaction')).body.data;
  assert.equal(Number(d.value), (await oracle.satisfactionFromSource(src, env.tenantA, AS_OF)).average);
  shape(d, 'rent.satisfaction', 'SCORE', 'crm.feedback_cases');
});

test('m9d642 GET /analytics/metrics/rent.repasses devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('rent.repasses')).body.data;
  assert.equal(Number(d.value), (await oracle.repassesFromSource(src, env.tenantA, AS_OF)).overdue);
  shape(d, 'rent.repasses', 'COUNT', 'finance.owner_repasses');
});

test('m9d642 isolamento entre empresas no KPI: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
});

test('m9d642 recusas: sem permissão 403, sem a permissão do domínio 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('rent.repasses', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  assert.equal((await get('rent.repasses', { perms: ['analytics:read'] })).status, 403, 'sem legal:read o domínio de Locação não abre');
  const missing = await get('rent.nao_existe');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code || missing.body.error?.code, 'ANALYTICS_METRIC_NOT_FOUND');
  const bad = await get('rent.tickets', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

for (const code of CODES) {
  test(`m9d642 ${code} tem origem registrada e a contagem da origem assinada é a dos registros que reproduzem o número`, async () => {
    const kpi = (await get(code)).body.data;
    const ref = kpi.sourceRefs[0];
    await http.inTx(env.tenantA, {}, async (tx) => {
      const detail = await openSourceDetail(http.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'legal:read']), code, ref, tx);
      const expected = { 'rent.tickets': 3, 'rent.satisfaction': 7, 'rent.repasses': 3 }[code];
      assert.equal(detail.count, expected, 'chamados em aberto de locação, registros de atendimento do mês e repasses atrasados');
      assert.equal(detail.ids.length, expected);
      assert.equal(new Set(detail.ids).size, expected, 'nenhum registro repetido');
    });
  });
}

test('m9d642 replay do mesmo evento não altera o valor (assertReplayIdempotent sobre os read models dos KPIs)', async () => {
  const t = env.tenantA;
  const [[feedbackRow]] = await env.admin.query('SELECT id FROM crm.feedback_cases WHERE company_id = :c LIMIT 1', { replacements: { c: t.companyId } });
  const [[repassRow]] = await env.admin.query('SELECT id FROM finance.owner_repasses WHERE company_id = :c LIMIT 1', { replacements: { c: t.companyId } });
  const cases = [['warranty.case.opened', 'rm_rental_tickets', bi.uuid()], ['crm.feedback_case.created', 'rm_rental_satisfaction', feedbackRow.id], ['finance.owner_repasse.created', 'rm_rental_repasses', repassRow.id]];
  for (const [type, model, id] of cases) {
    const event = bi.makeEvent(t, type, { id });
    const read = async () => (await env.admin.query(`SELECT * FROM analytics.${model} WHERE company_id = :c ORDER BY 3`, { replacements: { c: t.companyId } }))[0];
    await asserts.assertReplayIdempotent({ applyEvent: () => bi.apply(t, event), readRow: read });
  }
  const before = (await get('rent.repasses')).body.data.value;
  await http.inTx(t, { commit: true }, (tx) => materializeRentalCareKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
  assert.equal((await get('rent.repasses')).body.data.value, before);
});
