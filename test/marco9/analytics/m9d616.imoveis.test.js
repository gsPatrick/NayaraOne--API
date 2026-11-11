'use strict';

// M9-D616 — números dos read models de Imóveis, preços, Radar e corretores calculados pelo worker (uma empresa nova por execução).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');

const { src, apply, makeEvent, rows, pick, setSetting, runSchedule } = bi;
let env;
before(async () => { env = await bi.setup(); });
after(() => bi.teardown(env));

const iso = (date, time = '15:00:00') => `${date}T${time}Z`;

test('m9d616 carteira de imóveis por situação e faixa de dias sem venda, com faixas configuráveis', async () => {
  const p = (status, publishedAt, extra = {}) => src.property(env, env.cX, { status, publishedAt, created: iso('2025-01-01'), ...extra });
  const first = await p('AVAILABLE', iso('2026-10-20')); // 8 dias
  await p('AVAILABLE', iso('2026-05-01')); // 180 dias
  await p('AVAILABLE', iso('2026-01-01')); // 300 dias
  await p('SOLD', iso('2026-01-01'));
  await p('AVAILABLE', iso('2026-10-20'), { publication: 'INACTIVE' });
  const gone = await p('AVAILABLE', iso('2026-10-20'));
  await src.update(env, 'real_estate.properties', gone, { deleted_at: iso('2026-10-25') });
  await apply(env.cX, makeEvent(env.cX, 'property.created', { id: first }));
  const list = await rows(env, 'rm_property_portfolio', env.cX);
  const seen = Object.fromEntries(list.map((r) => [`${r.status}/${r.no_sale_days_bucket}`, r.active_count]));
  assert.deepEqual(seen, { 'AVAILABLE/ATE_30': 1, 'AVAILABLE/91_A_180': 1, 'AVAILABLE/ACIMA_180': 1, 'SOLD/NAO_SE_APLICA': 1 }, 'inativo e excluído ficam de fora; vendido não tem faixa');
  await setSetting(env, env.cX, 'analytics.imoveis.faixas_sem_venda_dias', '10,20');
  await apply(env.cX, makeEvent(env.cX, 'property.updated', { id: first }));
  const next = Object.fromEntries((await rows(env, 'rm_property_portfolio', env.cX)).map((r) => [`${r.status}/${r.no_sale_days_bucket}`, r.active_count]));
  assert.deepEqual(next, { 'AVAILABLE/ATE_10': 1, 'AVAILABLE/ACIMA_20': 2, 'SOLD/NAO_SE_APLICA': 1 }, 'faixas vindas do parâmetro');
});

test('m9d616 mudanças de preço por dia com soma e média da variação percentual', async () => {
  const h = (oldPrice, newPrice, day) => src.priceHistory(env, env.cX, { oldPrice, newPrice, at: iso(day) });
  await h('100.00', '110.00', '2026-10-26');
  await h('200.00', '180.00', '2026-10-26');
  await h('0.00', '50.00', '2026-10-26');
  await h('100.00', '150.00', '2026-10-27');
  await apply(env.cX, makeEvent(env.cX, 'property.price.changed', { offerId: src.uuid() }, { occurredAt: new Date(iso('2026-10-26')) }));
  await apply(env.cX, makeEvent(env.cX, 'property.price.changed', { offerId: src.uuid() }, { occurredAt: new Date(iso('2026-10-27')) }));
  const list = await rows(env, 'rm_property_price_changes', env.cX);
  const d26 = pick(list, { day: '2026-10-26' });
  assert.deepEqual([d26.changes, Number(d26.change_pct_sum), Number(d26.avg_change_pct)], [3, 0, 0], '+10% e -10% somam 0; o preço anterior zero conta como mudança mas fica fora do percentual');
  const d27 = pick(list, { day: '2026-10-27' });
  assert.deepEqual([d27.changes, Number(d27.change_pct_sum), Number(d27.avg_change_pct)], [1, 50, 50]);
});

test('m9d616 cruzamentos do Radar por dia e os que viraram negócio', async () => {
  const [p1, p2, pr1, pr2] = [src.uuid(), src.uuid(), src.uuid(), src.uuid()];
  await src.radarEvent(env, env.cX, { person: p1, property: pr1, at: iso('2026-10-27') });
  await src.radarEvent(env, env.cX, { person: p2, property: pr2, at: iso('2026-10-27') });
  await src.opportunity(env, env.cX, { person: p1, property: pr1, stage: 'WON', closedAt: iso('2026-10-28') });
  await src.opportunity(env, env.cX, { person: p2, property: pr2, stage: 'NEW' });
  await apply(env.cX, makeEvent(env.cX, 'radar.matched', { radarId: src.uuid(), personId: p1, propertyId: pr1 }, { occurredAt: new Date(iso('2026-10-27')) }));
  const r = pick(await rows(env, 'rm_radar_matches', env.cX), { day: '2026-10-27' });
  assert.deepEqual([r.matches, r.converted], [2, 1]);
});

test('m9d616 captação, leads recebidos e ganhos por corretor e mês', async () => {
  const b = src.uuid();
  await src.property(env, env.cX, { createdBy: b, created: iso('2026-10-05') });
  const prop = await src.property(env, env.cX, { createdBy: b, created: iso('2026-10-06') });
  await src.property(env, env.cX, { createdBy: b, created: iso('2026-09-06') });
  await src.opportunity(env, env.cX, { owner: b, created: iso('2026-10-02') });
  await src.opportunity(env, env.cX, { owner: b, created: iso('2026-10-03') });
  const won = await src.opportunity(env, env.cX, { owner: b, created: iso('2026-10-04'), stage: 'WON', closedAt: iso('2026-10-20') });
  await apply(env.cX, makeEvent(env.cX, 'property.created', { id: prop }));
  await apply(env.cX, makeEvent(env.cX, 'crm.opportunity.won', { id: won }));
  const list = (await rows(env, 'rm_broker_performance', env.cX)).filter((r) => r.broker_id === b);
  const oct = pick(list, { month: '2026-10' });
  assert.deepEqual([oct.captured, oct.leads_assigned, oct.won], [2, 3, 1]);
  assert.equal(pick(list, { month: '2026-09' }), undefined, 'setembro não foi tocado por nenhum evento');
  await runSchedule(env.cX);
  assert.equal(pick((await rows(env, 'rm_broker_performance', env.cX)).filter((r) => r.broker_id === b), { month: '2026-09' }).captured, 1, 'a agenda reconfere o que nenhum evento tocou');
});
