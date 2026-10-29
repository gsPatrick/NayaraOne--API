'use strict';

// M9-D710 — GET /v1/analytics/metrics/<código> dos três KPIs pela rota real: valor, unidade, status, versão, frescor e sourceRefs; isolamento entre empresas (404 ANALYTICS_SCOPE_NOT_FOUND);
// recusas; detalhe (drill-down) CRITICAL cuja contagem bate com o valor. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const kit = require('../_helpers/m9d710Env');
const sc = require('../_helpers/m9d710Scenario');
const oracle = require('../_helpers/m9d710Oracle');
const clock = require('../../../src/features/analytics/metrics/clock');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { materializeCommandEventKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, CODES, MODELS } = kit;
const WINDOW = oracle.windowEndingAt(oracle.BASE_NOW, 24);
const READ = ['analytics:read'];
const DOMAIN = { 'legal.contracts_signed': 'legal:read', 'crm.opportunities_won': 'crm:opportunities:read', 'fin.payments_settled_relevant': 'finance:read' };
const TABLES = { 'legal.contracts_signed': 'analytics.rm_command_events', 'crm.opportunities_won': 'analytics.rm_command_events', 'fin.payments_settled_relevant': 'analytics.rm_command_events' };
let env;
let src;
before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  const t = env.tenantA;
  // a empresa A é compartilhada com outros arquivos de teste, cujos contratos ativos (sem assinatura) já viraram linhas deste read model: parte de um estado limpo
  for (const table of ['rm_command_events', 'rm_applied_events']) await env.admin.query(`DELETE FROM analytics.${table} WHERE company_id = :c${table === 'rm_applied_events' ? " AND read_model = 'rm_command_events'" : ''}`, { replacements: { c: t.companyId } });
  await sc.contratos(src, t);
  await sc.oportunidades(src, t);
  await sc.pagamentos(src, t);
  await bi.runSchedule(t, bi.NOW);
  await http.inTx(t, { commit: true }, (tx) => materializeCommandEventKpis({ companyId: t.companyId, groupId: t.groupId }, AS_OF, tx));
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId };
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

const get = (code, { perms = [...READ, DOMAIN[code]], tenant = 'A', query = `asOf=${AS_OF}` } = {}) => env.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });
const shape = (d, code) => {
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode, d.valueNature], ['COUNT', 'OK', 1, code, 'ACTUAL']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === AS_OF);
  assert.ok(Array.isArray(d.sourceRefs) && d.sourceRefs.length === 1);
  assert.equal(d.sourceRefs[0].table, TABLES[code]);
};

test('m9d710 GET /analytics/metrics/legal.contracts_signed devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('legal.contracts_signed')).body.data;
  assert.equal(Number(d.value), (await oracle.contractsFromSource(src, env.tenantA, WINDOW)).count);
  shape(d, 'legal.contracts_signed');
});

test('m9d710 GET /analytics/metrics/crm.opportunities_won devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('crm.opportunities_won')).body.data;
  assert.equal(Number(d.value), (await oracle.opportunitiesFromSource(src, env.tenantA, WINDOW)).count);
  shape(d, 'crm.opportunities_won');
});

test('m9d710 GET /analytics/metrics/fin.payments_settled_relevant devolve valor, unidade, status, versão, frescor e sourceRefs', async () => {
  const d = (await get('fin.payments_settled_relevant')).body.data;
  assert.equal(Number(d.value), (await oracle.paymentsFromSource(src, env.tenantA, WINDOW)).count);
  shape(d, 'fin.payments_settled_relevant');
});

test('m9d710 isolamento entre empresas: empresa de outro grupo ou sem vínculo responde 404 ANALYTICS_SCOPE_NOT_FOUND e o valor de A nunca aparece', async () => {
  for (const code of CODES) {
    const res = await get(code, { query: `asOf=${AS_OF}&companyId=${env.tenantB.companyId}` });
    assert.equal(res.status, 404, code);
    assert.equal(res.body.code || res.body.error?.code, 'ANALYTICS_SCOPE_NOT_FOUND');
    assert.notEqual((await get(code, { tenant: 'B' })).status, 200, 'a empresa B não tem o indicador nem o snapshot da A');
  }
  const [bRows] = await env.admin.query('SELECT 1 FROM analytics.rm_command_events WHERE company_id = :c', { replacements: { c: env.tenantB.companyId } });
  assert.equal(bRows.length, 0);
});

test('m9d710 recusas: sem permissão 403, indicador inexistente 404 e período inválido 400', async () => {
  const noPerm = await get('fin.payments_settled_relevant', { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || noPerm.body.error?.code, 'PERMISSION_DENIED');
  const noDomain = await get('fin.payments_settled_relevant', { perms: READ });
  assert.equal(noDomain.status, 403, 'analytics:read sozinha não basta: falta a permissão do domínio dos dados');
  assert.equal(noDomain.body.error?.details?.permission, 'finance:read');
  assert.equal((await get('fin.nao_existe', { perms: [...READ, 'finance:read'] })).status, 404);
  const bad = await get('legal.contracts_signed', { query: 'asOf=2026-13-45' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || bad.body.error?.code, 'ANALYTICS_PERIOD_INVALID');
});

for (const code of CODES) {
  test(`m9d710 ${code} (CRITICAL) tem origem e detalhe paginado cuja contagem bate com o valor do KPI e sem a permissão do domínio é recusado`, async () => {
    const kpi = (await get(code)).body.data;
    const ref = kpi.sourceRefs[0];
    const ask = (permissions, page = 1) => http.inTx(env.tenantA, {}, (tx) => openDrilldown(http.ctxOf(env.tenantA, permissions), {
      metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste',
    }, tx));
    const rows = [];
    let page = 1;
    let body;
    do { body = await ask(['analytics:read', 'analytics:drilldown', DOMAIN[code]], page); rows.push(...body.rows); page += 1; } while (page <= body.totalPages);
    assert.equal(body.reconcileMode, 'COUNT');
    assert.equal(rows.length, Number(kpi.value), 'as linhas do detalhe são os fatos do KPI');
    assert.ok(rows.length > 0);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'um registro de origem por linha');
    await assert.rejects(ask(['analytics:read', 'analytics:drilldown']), (err) => err.status === 403 || /PERMISSION|FORBIDDEN/.test(String(err.code)), 'sem a permissão do domínio dos dados o detalhe é recusado');
  });
}
