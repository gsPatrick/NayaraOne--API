'use strict';

// M9-D632 — KPIs crm.visits, crm.proposals, prop.active_properties, prop.without_sale_by_period e prop.price_changes: cada número é refeito do ZERO só com as
// linhas-fonte (oráculo SQL) e comparado com o que o endpoint devolve; a virada do dia em São Paulo, o isolamento entre empresas e o replay do evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d632Scenario');
const oracle = require('../_helpers/m9d632Oracle');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const { src, makeEvent, apply, rows } = sc;
let env;
let visitIds;
const broker = sc.src.uuid();
const dim = async (code, key) => (await sc.readKpi(env.cX, code, { dimensionKey: key })).value;
/** Compara números decimais pelo valor (o snapshot guarda 4 casas: "60.0000" é o 60). */
const same = (actual, expected, message) => assert.equal(money.cmp(String(actual), String(expected)), 0, `${message || ''} esperado ${expected}, veio ${actual}`);
const get = (code, query = `asOf=${sc.TODAY}`, opts) => env.call(`/analytics/metrics/${code}?${query}`, opts);

before(async () => {
  env = await sc.setup({ withHttp: true });
  visitIds = await sc.seedVisits(env, env.cX, broker);
  await sc.seedProposals(env, env.cX, broker);
  await sc.seedProperties(env, env.cX, broker);
  await sc.seedPrices(env, env.cX);
  await sc.refreshModels(env.cX);
  await sc.kpis(env.cX);
});
after(() => sc.teardown(env));

test('m9d632 reproduz crm.visits a partir dos registros-fonte', async () => {
  const want = await oracle.visits(env, env.cX);
  const res = await get('crm.visits');
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.deepEqual([want.scheduled, want.done], [60, 48], 'o cenário é o exemplo do livro: 60 agendadas e 48 realizadas');
  same(d.value, want.scheduled);
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode], ['COUNT', 'OK', 1, 'crm.visits']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === sc.TODAY);
  assert.equal(d.sourceRefs[0].table, 'crm.visits');
  assert.equal(d.sourceRefs[0].count, want.scheduled, 'o sourceRefs conta as mesmas linhas');
  same(await dim('crm.visits', 'realizadas'), want.done);
  same(await dim('crm.visits', 'comparecimento_pct'), '80.00');
  same(await dim('crm.visits', `corretor:${broker}:agendadas`), 60);
});

test('m9d632 reproduz crm.proposals a partir dos registros-fonte', async () => {
  const want = await oracle.proposals(env, env.cX);
  const d = (await get('crm.proposals')).body.data;
  assert.deepEqual([want.sent, want.accepted, want.rejected, want.open], [12, 4, 3, 5], 'exemplo do livro: 12 enviadas, 4 aceitas, 3 recusadas, 5 em aberto');
  same(d.value, want.sent);
  assert.deepEqual([d.unit, d.status, d.version], ['COUNT', 'OK', 1]);
  same(await dim('crm.proposals', 'aceitas'), want.accepted);
  same(await dim('crm.proposals', 'recusadas'), want.rejected);
  same(await dim('crm.proposals', 'em_aberto'), want.open);
  same(await dim('crm.proposals', 'valor_total_brl'), want.valueSent, 'o valor proposto bate centavo a centavo');
  same(await dim('crm.proposals', 'taxa_aceite_pct'), '57.14');
  assert.equal(d.sourceRefs[0].count, want.sent);
});

test('m9d632 reproduz prop.active_properties a partir dos registros-fonte', async () => {
  const want = await oracle.activeProperties(env, env.cX);
  const d = (await get('prop.active_properties')).body.data;
  assert.deepEqual([want.total, want.sale, want.rent], [10, 6, 3], 'disponíveis: 6 com venda (inclui o rascunho), 3 só locação, 1 sem oferta');
  same(d.value, want.total);
  assert.deepEqual([d.unit, d.status], ['COUNT', 'OK']);
  same(await dim('prop.active_properties', 'finalidade:VENDA'), want.sale);
  same(await dim('prop.active_properties', 'finalidade:LOCACAO'), want.rent);
  same(await dim('prop.active_properties', 'finalidade:SEM_OFERTA'), want.total - want.sale - want.rent);
  same(await dim('prop.active_properties', 'tipo:HOUSE'), 5);
  assert.equal(d.sourceRefs[0].count, want.total);
});

test('m9d632 reproduz prop.without_sale_by_period a partir dos registros-fonte', async () => {
  const want = await oracle.withoutSale(env, env.cX);
  const d = (await get('prop.without_sale_by_period')).body.data;
  assert.deepEqual(want.counts, [2, 1, 1, 1], 'faixas 0-30 (10 e 30 dias), 31-90 (31), 91-180 (120) e 181+ (200)');
  same(d.value, want.counts.reduce((a, b) => a + b, 0));
  assert.deepEqual([d.unit, d.status], ['COUNT', 'OK']);
  const labels = ['ATE_30', '31_A_90', '91_A_180', 'ACIMA_180'];
  for (let i = 0; i < 4; i += 1) same(await dim('prop.without_sale_by_period', `faixa:${labels[i]}`), want.counts[i], labels[i]);
  same(await dim('prop.without_sale_by_period', 'sem_data'), 0);
  assert.equal(d.sourceRefs[0].count, 5, 'o detalhe tem as mesmas cinco linhas do KPI');
});

test('m9d632 reproduz prop.price_changes a partir dos registros-fonte', async () => {
  const want = await oracle.priceChanges(env, env.cX);
  const d = (await get('prop.price_changes')).body.data;
  assert.deepEqual([want.changes, want.withPrior, want.average], [9, 8, '-1.38'], '-11/8 = -1,375 arredonda para -1,38 (meio para cima, afastando do zero)');
  same(d.value, want.changes);
  assert.deepEqual([d.unit, d.status], ['COUNT', 'OK']);
  same(await dim('prop.price_changes', 'variacao_media_pct'), want.average);
  assert.equal(d.sourceRefs[0].count, want.changes);
});

test('m9d632 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const list = await rows(env, 'rm_crm_visits_proposals', env.cX, '3');
  const day = (iso) => list.find((r) => String(r.day).startsWith(iso) || (r.day instanceof Date && r.day.toISOString().startsWith(iso)));
  assert.ok(day('2026-10-28') && day('2026-10-28').visits_done >= 1, 'a visita de 02:30Z de 29/10 pertence ao dia 28 de São Paulo');
  assert.equal(list.filter((r) => `${r.day instanceof Date ? r.day.toISOString() : r.day}`.startsWith('2026-10-29')).length, 1, 'a de 03:30Z (00:30 de 29/10) é do dia 29');
  const prices = await rows(env, 'rm_property_price_changes', env.cX, '3');
  assert.equal(prices.filter((r) => `${r.day instanceof Date ? r.day.toISOString() : r.day}`.startsWith('2026-10-28')).length, 1, 'a mudança de preço de 23:30 é do dia 28');
  const proposals = await oracle.proposals(env, env.cX);
  assert.equal(proposals.sent, 12, 'a proposta enviada às 23:30 de 30/09 é de setembro e fica fora do mês');
});

test('m9d632 isolamento entre empresas no KPI', async () => {
  const other = await get('crm.visits', `asOf=${sc.TODAY}&companyId=${env.cY.companyId}`);
  assert.equal(other.status, 404);
  assert.equal(other.body.code || (other.body.error || {}).code, 'ANALYTICS_SCOPE_NOT_FOUND');
  const asB = await get('crm.visits', `asOf=${sc.TODAY}`, { tenant: 'B' });
  assert.notEqual(asB.status, 200, 'a empresa Y não tem o indicador nem o snapshot da X');
  assert.doesNotMatch(JSON.stringify(asB.body), /"value":"60/);
  const noPerm = await get('crm.visits', `asOf=${sc.TODAY}`, { perms: [] });
  assert.equal(noPerm.status, 403);
  assert.equal(noPerm.body.code || (noPerm.body.error || {}).code, 'PERMISSION_DENIED');
  assert.equal((await get('crm.nao_existe')).status, 404);
  const bad = await get('crm.visits', 'asOf=2026-13-45');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || (bad.body.error || {}).code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d632 replay do mesmo evento não altera o valor', async () => {
  const read = async () => (await Promise.all(sc.MODELS.map((m) => rows(env, m, env.cX)))).flat();
  const event = makeEvent(env.cX, 'crm.visit.completed', { id: visitIds[0] });
  await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.cX, event), readRow: read });
  const before = (await sc.readKpi(env.cX, 'crm.visits')).value;
  await sc.kpis(env.cX);
  same((await sc.readKpi(env.cX, 'crm.visits')).value, before, 'recalcular com o mesmo estado não muda o número nem cria revisão');
  assert.equal((await sc.readKpi(env.cX, 'crm.visits')).revisionNo, 1);
});

test('m9d632 dia passado: os KPIs de posição não são inventados e os de fluxo se calculam', async () => {
  const r = await sc.kpis(env.cX, { asOf: '2026-10-20' });
  assert.ok(r.kpis['crm.visits'] && r.kpis['prop.price_changes'], 'fluxo: calcula');
  assert.ok(!r.kpis['prop.active_properties'] && !r.kpis['prop.without_sale_by_period'], 'posição: a carteira não guarda histórico');
});

test('m9d632 o snapshot guarda o período do mês e a data-base', async () => {
  const [[s]] = await env.admin.query(`SELECT period_start::text AS s, period_end::text AS e FROM analytics.metric_snapshots sn JOIN analytics.metric_definitions d ON d.id = sn.metric_id
    WHERE sn.company_id = :c AND d.metric_code = 'crm.visits' AND sn.dimension_key = '' AND sn.as_of_date = :d`, { replacements: { c: env.cX.companyId, d: sc.TODAY } });
  assert.deepEqual([s.s, s.e], ['2026-10-01', '2026-10-28']);
  assert.ok(src);
});
