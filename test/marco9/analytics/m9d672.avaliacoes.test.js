'use strict';

// M9-D672 — sup.reviews e sup.satisfaction: o número refeito do zero só com os pedidos de avaliação da fonte, a amostra mínima, o fuso de São Paulo e a nota fora do mês.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d672Env');
const sc = require('../_helpers/m9d672Scenario');
const oracle = require('../_helpers/m9d672Oracle');
const src = require('../_helpers/m9d627Sources');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const MONTH = '2026-10';
let env;
before(async () => {
  env = await kit.setup();
  await sc.avaliacoes(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d672 reproduz sup.reviews a partir dos registros-fonte', async () => {
  const want = await oracle.reviewsFromSource(env, env.cX, MONTH);
  assert.deepEqual([want.count, want.average, want.byRating[5], want.byRating[4]], [5, '4.60', 3, 2], 'exemplo da demanda: 5,5,4,4,5 => 4,60; setembro e o pedido sem retorno ficam fora');
  const kpi = await kit.readKpi(env.cX, 'sup.reviews');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'SCORE', 1, 'sup.reviews']);
  assert.equal(money.cmp(kpi.value, want.average), 0, `${kpi.value} x ${want.average}`);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.reviews', 'reviews_qtd')), 5);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(Number(await kit.dimension(env.cX, 'sup.reviews', `nota_${n}_qtd`)), want.byRating[n], `contagem da nota ${n}`);
  assert.equal(money.cmp(await kit.dimension(env.cX, 'sup.reviews', 'plataforma:GOOGLE:nota_media'), '4.60'), 0);
  assert.equal(kpi.sourceRefs[0].table, 'marketing.review_requests');
  assert.equal(kpi.sourceRefs[0].count, 5, 'o filtro da origem reproduz o mesmo número');
});

test('m9d672 sup.reviews fica INCOMPLETE com valor nulo quando a regra de qualidade falha (menos de analytics.qualidade.min_amostra reviews)', async () => {
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 6); // são 5 avaliações
  const result = (await kit.kpis(env.cX)).sup.kpis['sup.reviews'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['INCOMPLETE', null, 'AMOSTRA_INSUFICIENTE']);
  assert.equal((await kit.readKpi(env.cX, 'sup.reviews')).value, null, 'nunca um número enganoso');
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 5);
  assert.equal((await kit.kpis(env.cX)).sup.kpis['sup.reviews'].status, 'OK');
});

test('m9d672 reproduz sup.satisfaction a partir dos registros-fonte', async () => {
  const want = await oracle.satisfactionFromSource(env, env.cX, MONTH);
  assert.deepEqual([want.count, want.average, want.positivePct], [5, '4.20', '80.00'], 'exemplo da demanda: 5,4,3,5,4 => 4,20 e 80,00%');
  const kpi = await kit.readKpi(env.cX, 'sup.satisfaction');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'SCORE', 1, 'sup.satisfaction']);
  assert.equal(money.cmp(kpi.value, want.average), 0);
  assert.equal(money.cmp(await kit.dimension(env.cX, 'sup.satisfaction', 'notas_4_5_pct'), want.positivePct), 0);
  assert.equal(Number(await kit.dimension(env.cX, 'sup.satisfaction', 'respostas_qtd')), 5);
  assert.equal(kpi.sourceRefs[0].count, 5);
});

test('m9d672 sup.satisfaction fica INCOMPLETE com valor nulo quando a amostra é insuficiente', async () => {
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 6);
  const result = (await kit.kpis(env.cX)).sup.kpis['sup.satisfaction'];
  assert.deepEqual([result.status, result.value, result.details.reason], ['INCOMPLETE', null, 'AMOSTRA_INSUFICIENTE']);
  assert.equal((await kit.readKpi(env.cX, 'sup.satisfaction')).value, null);
  await kit.setSetting(env, env.cX, 'analytics.qualidade.min_amostra', 5);
});

test('m9d672 timezone: avaliação concluída às 23:30 de São Paulo do último dia do mês cai no dia e no mês certos', async () => {
  const t = env.cY;
  const make = (completedAt, rating) => src.review(env, t, { status: 'COMPLETED', platform: 'GOOGLE', rating, completedAt, at: '2026-10-30T15:00:00Z' });
  for (const [rating, completedAt] of [[5, '2026-10-01T03:00:00Z'], [5, '2026-10-10T15:00:00Z'], [4, '2026-10-20T15:00:00Z'], [4, '2026-10-25T15:00:00Z'], [3, '2026-11-01T02:30:00Z']]) await make(completedAt, rating);
  await make('2026-11-01T03:00:00Z', 1); // 00:00 de novembro em São Paulo: fora de outubro
  await make('2026-10-01T02:59:00Z', 1); // 23:59 de 30/09 em São Paulo: fora de outubro
  await kit.rebuild(t);
  const want = await oracle.reviewsFromSource(env, t, MONTH);
  assert.deepEqual([want.count, want.sum], [5, 21], '01/10 00:00 SP e 31/10 23:30 SP entram; 30/09 23:59 SP e 01/11 00:00 SP não');
  const result = (await kit.kpis(t)).sup.kpis['sup.reviews'];
  assert.deepEqual([result.status, result.value], ['OK', '4.20']);
});
