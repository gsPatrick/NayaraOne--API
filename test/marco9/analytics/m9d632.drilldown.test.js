'use strict';

// M9-D632 — crm.proposals e prop.without_sale_by_period são CRITICAL: têm especificação de origem e detalhe, e o detalhe paginado de
// GET /analytics/metrics/:code/drilldown devolve linhas cuja contagem bate com o valor do KPI. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d632Scenario');
const { getSourceSpec } = require('../../../src/features/analytics/metrics/sourceRefs.spec');
const { detailOf } = require('../../../src/features/analytics/metrics/drilldown.details');
const { criticalCodes } = require('../../../src/features/analytics/metrics/seed/criticality.table');

let env;
const broker = sc.src.uuid();
const PERMS = ['analytics:read', 'analytics:drilldown', 'crm:opportunities:read'];

before(async () => {
  env = await sc.setup({ withHttp: true });
  await sc.seedProposals(env, env.cX, broker);
  await sc.seedProperties(env, env.cX, broker);
  await sc.refreshModels(env.cX, ['rm_crm_visits_proposals', 'rm_property_portfolio']);
  await sc.kpis(env.cX, { only: ['crm.proposals', 'prop.without_sale_by_period'] });
});
after(() => sc.teardown(env));

async function pages(code) {
  const kpi = (await env.call(`/analytics/metrics/${code}?asOf=${sc.TODAY}`, { perms: PERMS })).body.data;
  const ref = kpi.sourceRefs[0];
  assert.ok(ref.filterHash && ref.filterSignature, 'a referência traz o filtro assinado que abre o detalhe');
  const out = [];
  let page = 1;
  let body;
  do {
    const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, page: String(page), pageSize: '5' });
    const res = await env.call(`/analytics/metrics/${code}/drilldown?${q}`, { perms: PERMS });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    body = res.body.data;
    out.push(...body.rows);
    page += 1;
  } while (page <= body.totalPages);
  return { kpi, rows: out, last: body };
}

test('m9d632 crm.proposals e prop.without_sale_by_period têm origem e detalhe registrados', () => {
  for (const code of ['crm.proposals', 'prop.without_sale_by_period']) {
    assert.ok(criticalCodes().includes(code), `${code} é CRITICAL na tabela da M9-D712`);
    assert.ok(getSourceSpec(code), `${code}: registerSourceSpec`);
    assert.ok(detailOf(getSourceSpec(code)).columns.length >= 3, `${code}: registerDrilldownDetail`);
  }
});

test('m9d632 o detalhe de crm.proposals tem uma linha por proposta enviada no período e a contagem bate com o KPI', async () => {
  const { kpi, rows, last } = await pages('crm.proposals');
  assert.equal(Number(kpi.value), 12);
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map((r) => r.id)).size, 12, 'nenhuma linha repetida entre páginas');
  assert.equal(last.reconcileMode, 'COUNT');
  assert.equal(last.aggregate.count, Number(kpi.value));
  assert.ok(rows.every((r) => r.contribution === '1' && r.link === '/painel/crm/propostas' && 'status' in r.fields && 'value' in r.fields));
});

test('m9d632 o detalhe de prop.without_sale_by_period tem os imóveis publicados com venda e a contagem bate com o KPI', async () => {
  const { kpi, rows, last } = await pages('prop.without_sale_by_period');
  assert.equal(Number(kpi.value), 5);
  assert.equal(rows.length, 5);
  assert.equal(last.aggregate.count, 5);
  assert.ok(rows.every((r) => /^\/painel\/imoveis\/[0-9a-f-]{36}$/.test(r.link) && r.fields.publication_status === 'PUBLISHED' && r.fields.availability_status === 'AVAILABLE'));
});

test('m9d632 sem a permissão do detalhe o número aparece e as linhas não', async () => {
  const kpi = (await env.call(`/analytics/metrics/crm.proposals?asOf=${sc.TODAY}`, { perms: ['analytics:read'] })).body.data;
  const ref = kpi.sourceRefs[0];
  assert.deepEqual([ref.restricted, ref.idsSample, ref.count], [true, [], 12]);
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature });
  const res = await env.call(`/analytics/metrics/crm.proposals/drilldown?${q}`, { perms: ['analytics:read'] });
  assert.equal(res.status, 403);
  assert.equal(res.body.code || (res.body.error || {}).code, 'ANALYTICS_DRILLDOWN_FORBIDDEN');
});
