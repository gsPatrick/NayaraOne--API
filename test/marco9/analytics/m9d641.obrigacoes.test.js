'use strict';

// M9-D641 — rent.obligations_pending: o número refeito do zero só com as exigências e trocas de titularidade da fonte (abertas, vencidas, a vencer e a mais antiga), o fuso de
// São Paulo no prazo e a regra de qualidade (obrigação sem prazo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d641Env');
const sc = require('../_helpers/m9d641Scenario');
const oracle = require('../_helpers/m9d641Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await sc.obrigacoes(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d641 reproduz rent.obligations_pending a partir dos registros-fonte', async () => {
  const want = await oracle.obligationsFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual(want, { open: 6, overdue: 4, upcoming: 2, withoutDeadline: 0, oldest: 12 }, 'exemplo da demanda no formato: abertas, vencidas e a mais antiga em dias');
  const kpi = await kit.readKpi(env.cX, 'rent.obligations_pending');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'rent.obligations_pending']);
  assert.equal(Number(kpi.value), want.open);
  const dim = async (key) => Number(await kit.dimension(env.cX, 'rent.obligations_pending', key));
  assert.deepEqual([await dim('vencidas_qtd'), await dim('a_vencer_qtd'), await dim('mais_antiga_dias')], [want.overdue, want.upcoming, want.oldest]);
  assert.equal(await dim('tipo:REQUIREMENT:abertas_qtd'), 4);
  assert.equal(await dim('tipo:UTILITY:abertas_qtd'), 2);
  assert.equal(kpi.sourceRefs[0].table, 'legal.contract_requirements');
});

test('m9d641 rent.obligations_pending fica DEGRADED com valor nulo quando a regra de qualidade falha (obrigação sem prazo)', async () => {
  const t = env.cY;
  await sc.requirement(env, t, await sc.contract(env, t, { starts_at: sc.iso('10-20') }));
  await kit.rebuild(t);
  assert.equal((await kit.kpis(t)).rent.kpis['rent.obligations_pending'].status, 'OK');
  await sc.requirement(env, t, await sc.contract(env, t, { starts_at: null })); // contrato sem início de vigência: a exigência não tem prazo
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.obligations_pending'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutDeadline], ['DEGRADED', null, 'OBRIGACAO_SEM_PRAZO', '1']);
  assert.equal((await kit.readKpi(t, 'rent.obligations_pending')).value, null, 'nunca um número enganoso');
});

test('m9d641 timezone: prazo às 23:30 de São Paulo cai no dia certo (vence ontem ou ainda é hoje)', async () => {
  const t = env.cX;
  const before = await oracle.obligationsFromSource(env, t, kit.AS_OF);
  await sc.requirement(env, t, await sc.contract(env, t, { starts_at: sc.iso('10-28', 2, 30) })); // 27/10 23:30 em SP: vencida há 1 dia
  await sc.requirement(env, t, await sc.contract(env, t, { starts_at: sc.iso('10-29', 2, 30) })); // 28/10 23:30 em SP: hoje, ainda não venceu
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.obligations_pending'];
  const want = await oracle.obligationsFromSource(env, t, kit.AS_OF);
  assert.deepEqual([want.open, want.overdue], [before.open + 2, before.overdue + 1]);
  assert.deepEqual([result.status, result.details.overdue, result.details.upcoming], ['OK', String(want.overdue), String(want.upcoming)]);
  assert.equal(result.details.oldestOverdueDays, '12');
});
