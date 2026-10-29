'use strict';

// M9-D633 — KPIs radar.matches, crm.broker_capture e crm.broker_conversion: cada número é refeito do ZERO só com as linhas-fonte (oráculo SQL) e comparado com
// o que o endpoint devolve; a virada do dia em São Paulo, o isolamento entre empresas e o replay do evento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d633Scenario');
const oracle = require('../_helpers/m9d633Oracle');
const asserts = require('../_helpers/readModelAsserts');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const { makeEvent, apply, rows } = sc;
const ana = sc.src.uuid();
const bruno = sc.src.uuid();
let env;
const same = (actual, expected, message) => assert.equal(money.cmp(String(actual), String(expected)), 0, `${message || ''} esperado ${expected}, veio ${actual}`);
const dim = async (code, key) => (await sc.readKpi(env.cX, code, { dimensionKey: key })).value;
const get = (code, query = `asOf=${sc.TODAY}`, opts) => env.call(`/analytics/metrics/${code}?${query}`, opts);

before(async () => {
  env = await sc.setup({ withHttp: true });
  await sc.setSetting(env, env.cX, 'analytics.qualidade.max_nulos_pct.created_by', 10); // o rebuild bloqueia com mais de 1% sem captador; o cenário tem 4,76%
  await sc.seedRadar(env, env.cX, ana, bruno);
  await sc.seedCapture(env, env.cX, ana, bruno);
  await sc.seedClosed(env, env.cX, ana, bruno);
  await sc.refreshModels(env.cX);
  await sc.kpis(env.cX);
});
after(() => sc.teardown(env));

test('m9d633 reproduz radar.matches a partir dos registros-fonte', async () => {
  const want = await oracle.radar(env, env.cX);
  const res = await get('radar.matches');
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.deepEqual([want.matches, want.sent, want.converted, want.invalid], [12, 10, 2, 0]);
  same(d.value, want.matches);
  assert.deepEqual([d.unit, d.status, d.version, d.metricCode], ['COUNT', 'OK', 1, 'radar.matches']);
  assert.ok(d.sourceSnapshotAt && d.refreshedAt && d.freshness.asOfDate === sc.TODAY);
  assert.equal(d.sourceRefs[0].table, 'integration.outbox_events');
  assert.equal(d.sourceRefs[0].count, want.matches);
  same(await dim('radar.matches', 'enviados'), want.sent);
  same(await dim('radar.matches', 'convertidos'), want.converted);
  same(await dim('radar.matches', 'taxa_pct'), '16.67');
  same(await dim('radar.matches', 'origem:AVULSO'), 7);
  same(await dim('radar.matches', 'origem:COM_OPORTUNIDADE'), 5);
  same(await dim('radar.matches', `corretor:${ana}:matches`), 7);
});

test('m9d633 reproduz crm.broker_capture a partir dos registros-fonte', async () => {
  const want = await oracle.capture(env, env.cX);
  const res = await get('crm.broker_capture');
  const d = res.body.data;
  assert.equal(want.total, 21, 'Ana 12 + Bruno 8 + Sem captador 1');
  assert.deepEqual([d.status, d.unit, d.version], ['OK', 'COUNT', 1]);
  same(d.value, want.total);
  same(await dim('crm.broker_capture', `corretor:${ana}:captados`), want.byBroker[ana]);
  same(await dim('crm.broker_capture', `corretor:${bruno}:captados`), want.byBroker[bruno]);
  same(await dim('crm.broker_capture', 'sem_captador'), want.byBroker.null);
  same(await dim('crm.broker_capture', 'valor_medio_brl'), want.average, 'valor médio dos captados, centavo a centavo');
  assert.equal(d.sourceRefs[0].count, want.total);
});

test('m9d633 reproduz crm.broker_conversion a partir dos registros-fonte', async () => {
  const want = await oracle.conversion(env, env.cX);
  const res = await get('crm.broker_conversion');
  const d = res.body.data;
  assert.deepEqual([want.brokers[ana].won, want.brokers[ana].lost, want.rate], [7, 13, '34.78']);
  assert.deepEqual([d.status, d.unit, d.version], ['OK', 'PERCENT', 1]);
  same(d.value, want.rate);
  same(await dim('crm.broker_conversion', `corretor:${ana}:taxa_pct`), '35.00');
  same(await dim('crm.broker_conversion', `corretor:${ana}:fechadas_qtd`), 20);
  await assert.rejects(() => sc.readKpi(env.cX, 'crm.broker_conversion', { dimensionKey: `corretor:${bruno}:taxa_pct` }), (err) => err.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'Bruno tem 3 fechadas (< 5): fora do ranking');
  assert.equal(d.sourceRefs[0].count, want.won + want.lost);
});

test('m9d633 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const list = await rows(env, 'rm_radar_matches', env.cX, '3');
  const key = (r) => (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10);
  assert.ok(list.find((r) => key(r) === '2026-10-28' && r.matches === 1), 'o cruzamento de 02:30Z de 29/10 pertence ao dia 28 de São Paulo');
  assert.ok(list.find((r) => key(r) === '2026-10-29' && r.matches === 1), 'o de 03:30Z (00:30 de 29/10) é do dia 29 e fica fora do mês até 28/10');
  same((await oracle.radar(env, env.cX)).matches, 12);
});

test('m9d633 isolamento entre empresas no KPI', async () => {
  for (const code of ['radar.matches', 'crm.broker_capture', 'crm.broker_conversion']) {
    const other = await get(code, `asOf=${sc.TODAY}&companyId=${env.cY.companyId}`);
    assert.equal(other.status, 404, code);
    assert.equal(other.body.code || (other.body.error || {}).code, 'ANALYTICS_SCOPE_NOT_FOUND', code);
    const asB = await get(code, `asOf=${sc.TODAY}`, { tenant: 'B' });
    assert.notEqual(asB.status, 200, `${code}: a empresa Y não tem o indicador nem o snapshot da X`);
  }
  assert.equal((await get('radar.matches', `asOf=${sc.TODAY}`, { perms: [] })).status, 403);
  const bad = await get('radar.matches', 'asOf=2026-13-45');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code || (bad.body.error || {}).code, 'ANALYTICS_PERIOD_INVALID');
});

test('m9d633 replay do mesmo evento não altera o valor', async () => {
  const read = async () => (await Promise.all(['rm_radar_matches', 'rm_broker_performance'].map((m) => rows(env, m, env.cX)))).flat();
  const event = makeEvent(env.cX, 'radar.matched', { radarId: sc.src.uuid(), personId: sc.src.uuid(), propertyId: sc.src.uuid() }, { occurredAt: new Date('2026-10-10T15:00:00Z') });
  await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.cX, event), readRow: read });
  const won = await sc.src.opportunity(env, env.cX, { owner: ana, stage: 'CLOSED_WON', closedAt: sc.iso('2026-10-15'), created: sc.iso('2026-09-01') });
  await sc.src.update(env, 'crm.opportunities', won, { deleted_at: sc.iso('2026-10-16') });
  const lostEvent = makeEvent(env.cX, 'crm.opportunity.lost', { id: won });
  await asserts.assertReplayIdempotent({ applyEvent: () => apply(env.cX, lostEvent), readRow: read });
  const before = (await sc.readKpi(env.cX, 'crm.broker_conversion')).value;
  await sc.kpis(env.cX);
  same((await sc.readKpi(env.cX, 'crm.broker_conversion')).value, before, 'recalcular com o mesmo estado não muda o número');
});
