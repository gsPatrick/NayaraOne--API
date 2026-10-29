'use strict';

// M9-D642 — rent.repasses: o número refeito do zero só com os repasses da fonte (atrasados, pagos no mês, pendentes no prazo e % no prazo), o prazo do administrador, o fuso de
// São Paulo no dia do pagamento e a regra de qualidade (repasse sem data prevista).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d642Env');
const sc = require('../_helpers/m9d642Scenario');
const oracle = require('../_helpers/m9d642Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await sc.repasses(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const dim = async (t, key) => Number(await kit.dimension(t, 'rent.repasses', key));

test('m9d642 reproduz rent.repasses a partir dos registros-fonte', async () => {
  const want = await oracle.repassesFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual([want.overdue, want.overdueCents, want.paid, want.paidCents, want.pendingOnTime, want.due, want.onTime, want.onTimePct], [3, 120000, 4, 205000, 1, 6, 2, 33.33]);
  const kpi = await kit.readKpi(env.cX, 'rent.repasses');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'rent.repasses']);
  assert.equal(Number(kpi.value), want.overdue, 'o valor é a posição: repasses atrasados na data-base');
  assert.deepEqual([await dim(env.cX, 'atrasados_brl'), await dim(env.cX, 'pagos_qtd'), await dim(env.cX, 'pagos_brl')], [want.overdueCents / 100, want.paid, want.paidCents / 100]);
  assert.deepEqual([await dim(env.cX, 'pendentes_no_prazo_qtd'), await dim(env.cX, 'pendentes_no_prazo_brl')], [want.pendingOnTime, 2000]);
  assert.deepEqual([await dim(env.cX, 'devidos_qtd'), await dim(env.cX, 'no_prazo_qtd'), await dim(env.cX, 'no_prazo_pct')], [want.due, want.onTime, want.onTimePct]);
  assert.equal(kpi.sourceRefs[0].table, 'finance.owner_repasses');
});

test('m9d642 rent.repasses fica DEGRADED com valor nulo quando a regra de qualidade falha (repasse sem data prevista)', async () => {
  const t = env.cY;
  await sc.repass(env, t, '500.00', '2026-09');
  await kit.rebuild(t);
  assert.equal((await kit.kpis(t)).rent.kpis['rent.repasses'].status, 'OK');
  await sc.repass(env, t, '300.00', null, 'PENDING', null, true); // registro antigo sem mês de referência: sem data prevista
  await kit.rebuild(t);
  let result = (await kit.kpis(t)).rent.kpis['rent.repasses'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutDueDate], ['DEGRADED', null, 'REPASSE_SEM_DATA_PREVISTA', '1']);
  assert.equal((await kit.readKpi(t, 'rent.repasses')).value, null, 'nunca um número enganoso');
  await sc.repass(env, t, '200.00', '2026-13', 'PENDING', null, true); // mês inválido também não tem data prevista (e não derruba o cálculo)
  await kit.rebuild(t);
  result = (await kit.kpis(t)).rent.kpis['rent.repasses'];
  assert.deepEqual([result.status, result.value, result.details.withoutDueDate], ['DEGRADED', null, '2']);
});

test('m9d642 timezone: pagamento às 23:30 de São Paulo cai no dia certo (no prazo ou atrasado)', async () => {
  const want = await oracle.repassesFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual([want.onTime, want.due], [2, 6], 'pago às 23:30 de 10/10 em SP (02:30Z de 11/10) é no prazo; às 00:30 de 11/10 em SP é atraso');
  assert.equal(await dim(env.cX, 'no_prazo_qtd'), 2);
});

test('m9d642 o prazo do repasse é parâmetro do administrador: o atrasado e o devido seguem o prazo configurado', async () => {
  const x = env.cX;
  await kit.setSetting(env, x, 'analytics.locacao.repasse_prazo_dias', 40);
  await kit.rebuild(x);
  const moved = (await kit.kpis(x)).rent.kpis['rent.repasses'];
  const want = await oracle.repassesFromSource(env, x, kit.AS_OF, 40);
  assert.deepEqual([want.overdue, want.due, want.onTime], [1, 2, 1], 'com 40 dias de prazo só o repasse de agosto venceu em outubro');
  assert.deepEqual([moved.value, moved.details.due, moved.details.onTime], [String(want.overdue), String(want.due), String(want.onTime)]);
  await kit.setSetting(env, x, 'analytics.locacao.repasse_prazo_dias', 10);
  await kit.rebuild(x);
  assert.equal((await kit.kpis(x)).rent.kpis['rent.repasses'].value, '3');
});
