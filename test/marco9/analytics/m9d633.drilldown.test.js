'use strict';

// M9-D633 — radar.matches é CRITICAL: tem especificação de origem e detalhe registrados, e o detalhe paginado de GET /analytics/metrics/:code/drilldown devolve
// linhas cuja contagem bate com o valor do KPI. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d633Scenario');
const { getSourceSpec } = require('../../../src/features/analytics/metrics/sourceRefs.spec');
const { detailOf } = require('../../../src/features/analytics/metrics/drilldown.details');
const { criticalCodes } = require('../../../src/features/analytics/metrics/seed/criticality.table');

let env;
const PERMS = ['analytics:read', 'analytics:drilldown', 'crm:opportunities:read'];
before(async () => {
  env = await sc.setup({ withHttp: true });
  await sc.seedRadar(env, env.cX, sc.src.uuid(), sc.src.uuid());
  await sc.refreshModels(env.cX, ['rm_radar_matches']);
  await sc.kpis(env.cX, { only: ['radar.matches'] });
});
after(() => sc.teardown(env));

test('m9d633 radar.matches tem origem e detalhe registrados', () => {
  assert.ok(criticalCodes().includes('radar.matches'), 'CRITICAL na tabela da M9-D712');
  assert.ok(getSourceSpec('radar.matches'), 'registerSourceSpec');
  assert.ok(detailOf(getSourceSpec('radar.matches')).columns.length >= 2, 'registerDrilldownDetail');
});

test('m9d633 o detalhe de radar.matches tem uma linha por cruzamento do período e a contagem bate com o KPI', async () => {
  const kpi = (await env.call(`/analytics/metrics/radar.matches?asOf=${sc.TODAY}`, { perms: PERMS })).body.data;
  const ref = kpi.sourceRefs[0];
  const rows = [];
  let page = 1;
  let body;
  do {
    const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, page: String(page), pageSize: '5' });
    const res = await env.call(`/analytics/metrics/radar.matches/drilldown?${q}`, { perms: PERMS });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    body = res.body.data;
    rows.push(...body.rows);
    page += 1;
  } while (page <= body.totalPages);
  assert.equal(Number(kpi.value), 12);
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map((r) => r.id)).size, 12, 'nenhuma linha repetida entre páginas');
  assert.equal(body.reconcileMode, 'COUNT');
  assert.equal(body.aggregate.count, Number(kpi.value));
  assert.ok(rows.every((r) => r.contribution === '1' && r.link === '/painel/radar' && 'aggregate_id' in r.fields));
});

test('m9d633 sem a permissão do detalhe o número aparece e as linhas não', async () => {
  const kpi = (await env.call(`/analytics/metrics/radar.matches?asOf=${sc.TODAY}`, { perms: ['analytics:read'] })).body.data;
  const ref = kpi.sourceRefs[0];
  assert.deepEqual([ref.restricted, ref.idsSample, ref.count], [true, [], 12]);
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature });
  const res = await env.call(`/analytics/metrics/radar.matches/drilldown?${q}`, { perms: ['analytics:read'] });
  assert.equal(res.status, 403);
});
