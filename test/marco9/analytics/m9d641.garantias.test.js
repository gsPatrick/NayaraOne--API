'use strict';

// M9-D641 — rent.guarantees_expiring: o número refeito do zero só com as garantias da fonte (janelas de 30 e 60 dias, vencidas, contrato ACTIVE de locação), a regra de qualidade
// (garantia sem data de vencimento, exceto tipos sem vencimento) e o parâmetro dos tipos sem vencimento.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d641Env');
const sc = require('../_helpers/m9d641Scenario');
const oracle = require('../_helpers/m9d641Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await sc.garantias(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d641 reproduz rent.guarantees_expiring a partir dos registros-fonte', async () => {
  const want = await oracle.guaranteesFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual(want, { in30: 3, in60: 5, expired: 1, withoutDate: 0 }, 'hoje, hoje+29 e uma no meio nos 30 d; hoje+30 e hoje+59 só nos 60 d; hoje+60 fora; ontem vencida');
  const kpi = await kit.readKpi(env.cX, 'rent.guarantees_expiring');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'rent.guarantees_expiring']);
  assert.equal(Number(kpi.value), want.in30);
  const dim = async (key) => Number(await kit.dimension(env.cX, 'rent.guarantees_expiring', key));
  assert.deepEqual([await dim('vencendo_30d_qtd'), await dim('vencendo_60d_qtd'), await dim('vencidas_qtd')], [want.in30, want.in60, want.expired]);
  assert.equal(await dim('tipo:INSURANCE:vencendo_30d_qtd'), 2);
  assert.equal(await dim('tipo:INSURANCE:vencendo_60d_qtd'), 3);
  assert.equal(kpi.sourceRefs[0].table, 'legal.guarantees');
  assert.equal(kpi.sourceRefs[0].count, want.in30, 'o filtro da origem reproduz o mesmo número (hoje até hoje+29)');
});

test('m9d641 rent.guarantees_expiring fica INCOMPLETE com valor nulo quando a regra de qualidade falha (garantia sem data de vencimento, exceto tipos sem vencimento)', async () => {
  const t = env.cY;
  const c = await sc.contract(env, t);
  await sc.guarantee(env, t, c, 'GUARANTOR', '2026-11-01');
  await sc.guarantee(env, t, c, 'DEPOSIT', null); // tipo sem vencimento: não rebaixa
  await kit.rebuild(t);
  const ok = (await kit.kpis(t)).rent.kpis['rent.guarantees_expiring'];
  assert.deepEqual([ok.status, ok.value], ['OK', '1']);
  await sc.guarantee(env, t, c, 'GUARANTOR', null); // fiador sem data
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.guarantees_expiring'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutDate], ['INCOMPLETE', null, 'GARANTIA_SEM_VENCIMENTO', '1']);
  assert.equal((await kit.readKpi(t, 'rent.guarantees_expiring')).value, null, 'nunca um número enganoso');
  await kit.setSetting(env, t, 'analytics.locacao.garantias_sem_vencimento', 'DEPOSIT,GUARANTOR'); // o administrador diz que o fiador também não tem vencimento
  await kit.rebuild(t);
  assert.equal((await kit.kpis(t)).rent.kpis['rent.guarantees_expiring'].status, 'OK');
});

test('m9d641 os tipos sem vencimento são parâmetro: sem DEPOSIT na lista a caução sem data rebaixa o KPI', async () => {
  const t = env.cY;
  await kit.setSetting(env, t, 'analytics.locacao.garantias_sem_vencimento', 'CAPITALIZATION_TITLE');
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.guarantees_expiring'];
  assert.deepEqual([result.status, result.value, result.details.withoutDate], ['INCOMPLETE', null, '2']);
});

test('m9d641 o número das garantias vencendo é o mesmo com o relógio às 23:30 e às 00:30 de São Paulo do dia da data-base', async () => {
  for (const instant of ['2026-10-29T02:30:00Z', '2026-10-29T03:30:00Z']) { // 23:30 de 28/10 e 00:30 de 29/10 em São Paulo (UTC já é 29/10 nos dois)
    kit.registry.clock.setClock(() => new Date(instant));
    const result = (await kit.kpis(env.cX, kit.AS_OF)).rent.kpis['rent.guarantees_expiring'];
    assert.deepEqual([result.status, result.value], ['OK', '3'], `data-base ${kit.AS_OF} lida com o relógio em ${instant}`);
  }
  kit.registry.clock.setClock(() => kit.NOW);
});
