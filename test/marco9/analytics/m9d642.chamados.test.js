'use strict';

// M9-D642 — rent.tickets: o número refeito do zero só com os chamados de manutenção da fonte (em aberto, abertos e fechados no mês e tempo médio), o fuso de São Paulo na
// abertura e no fechamento e a regra de qualidade (chamado fechado sem data de abertura coerente).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const kit = require('../_helpers/m9d642Env');
const sc = require('../_helpers/m9d642Scenario');
const oracle = require('../_helpers/m9d642Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await sc.chamados(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d642 reproduz rent.tickets a partir dos registros-fonte', async () => {
  const want = await oracle.ticketsFromSource(env, env.cX, kit.AS_OF);
  assert.deepEqual([want.open, want.opened, want.closed, want.average], [3, 6, 4, 18.6], 'cenário: 3 em aberto, 6 abertos e 4 fechados no mês, média 18,6 h');
  const kpi = await kit.readKpi(env.cX, 'rent.tickets');
  assert.deepEqual([kpi.status, kpi.unit, kpi.version, kpi.metricCode], ['OK', 'COUNT', 1, 'rent.tickets']);
  assert.equal(Number(kpi.value), want.open, 'o valor é a posição: chamados em aberto na data-base');
  const dim = async (key) => Number(await kit.dimension(env.cX, 'rent.tickets', key));
  assert.deepEqual([await dim('abertos_periodo_qtd'), await dim('fechados_periodo_qtd'), await dim('tempo_medio_resolucao_horas')], [want.opened, want.closed, want.average]);
  assert.equal(kpi.sourceRefs[0].table, 'construction.maintenance_cases');
});

test('m9d642 rent.tickets fica DEGRADED com valor nulo quando a regra de qualidade falha (fechado sem data de abertura coerente)', async () => {
  const t = env.cY;
  const rented = crypto.randomUUID();
  await sc.contract(env, t, { property_id: rented });
  await sc.maintenance(env, t, rented, 'OPEN', sc.iso('10-20'));
  await kit.rebuild(t);
  assert.equal((await kit.kpis(t)).rent.kpis['rent.tickets'].status, 'OK');
  await sc.maintenance(env, t, rented, 'CLOSED', sc.iso('10-22'), sc.iso('10-21')); // fechado antes de aberto: a data de abertura não vale
  await kit.rebuild(t);
  const result = (await kit.kpis(t)).rent.kpis['rent.tickets'];
  assert.deepEqual([result.status, result.value, result.details.reason, result.details.withoutOpenDate], ['DEGRADED', null, 'CHAMADO_SEM_DATA_DE_ABERTURA', '1']);
  assert.equal((await kit.readKpi(t, 'rent.tickets')).value, null, 'nunca um número enganoso');
});

test('m9d642 timezone: chamado das 23:30 de São Paulo cai no dia certo (abertura em setembro, fechamento em outubro)', async () => {
  const want = await oracle.ticketsFromSource(env, env.cX, kit.AS_OF);
  const result = (await kit.kpis(env.cX)).rent.kpis['rent.tickets'];
  assert.equal(want.opened, 6, 'aberto às 23:30 de 30/09 em SP (02:30Z de 01/10) não entra nos abertos de outubro e o das 00:30 de 01/10 em SP entra');
  assert.deepEqual([result.details.openedInPeriod, result.details.closedInPeriod, result.details.averageResolutionHours], ['6', '4', '18.6']);
});

test('m9d642 chamado de imóvel sem locação ou de contrato de venda não entra em nenhum número', async () => {
  const result = (await kit.kpis(env.cX)).rent.kpis['rent.tickets'];
  assert.equal(result.details.open, '3', 'os dois chamados abertos fora de locação ficam de fora');
});
