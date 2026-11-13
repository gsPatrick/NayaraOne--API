'use strict';

/**
 * M9-D631 — KPI crm.opportunities_by_stage (Oportunidades por estágio), versão 1. Posição no fim do dia-base: contagem de oportunidades por estágio do
 * funil (as em aberto, do rm_crm_opportunity_stage, e os estágios terminais WON, LOST e WITHDRAWN fechados no mês de São Paulo da
 * data-base, do rm_crm_outcome), na ordem do funil (parâmetro stageOrder), e o tempo médio parado no estágio atual em dias (1 casa, meio para cima).
 * Entrada: { stages: [{ stage, brokerId, count, stalled, idleDays }], outcome: [{ brokerId, won, lost, withdrawn }] } (idleDays = soma dos dias
 * parados das oportunidades da linha). Regra de qualidade: oportunidade sem estágio -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, groupSum } = require('./_crmKpi');

const TERMINALS = [['WON', 'won'], ['LOST', 'lost'], ['WITHDRAWN', 'withdrawn']];

function rank(order) {
  const index = new Map((order || []).map((s, i) => [s, i]));
  return (stage) => (index.has(stage) ? index.get(stage) : index.size);
}

const stageOf = (r) => String(r.stage || '').trim().toUpperCase(); // o funil usa o código em maiúsculas; "novo" e "NOVO" são o mesmo estágio

function openStages(rows) {
  const count = groupSum(rows, stageOf, (r) => r.count);
  const stalled = groupSum(rows, stageOf, (r) => r.stalled);
  const idle = groupSum(rows, stageOf, (r) => r.idleDays);
  return { count, stalled, idle };
}

function compute(input, params = {}) {
  const open = openStages(input.stages || []);
  const outcome = input.outcome || [];
  const missing = open.count.get('') || '0';
  const list = [...open.count.entries()].filter(([stage]) => stage !== '').map(([stage, count]) => ({
    stage, count: money.count(count), stalled: money.count(open.stalled.get(stage) || 0), avgIdleDays: money.cmp(count, 0) > 0 ? money.round(money.div(open.idle.get(stage) || 0, count), 1) : null,
  }));
  for (const [stage, field] of TERMINALS) list.push({ stage, count: money.count(money.sum(outcome.map((r) => r[field] || 0))), stalled: '0', avgIdleDays: null });
  const order = rank(params.stageOrder);
  list.sort((a, b) => order(a.stage) - order(b.stage) || (a.stage < b.stage ? -1 : 1));
  const total = money.count(money.sum(list.map((s) => s.count)));
  const stalledTotal = money.count(money.sum(list.map((s) => s.stalled)));
  const byBroker = groupSum([
    ...(input.stages || []).map((r) => ({ brokerId: r.brokerId, n: r.count })),
    ...outcome.map((r) => ({ brokerId: r.brokerId, n: money.toString(money.sum([r.won || 0, r.lost || 0, r.withdrawn || 0])) })),
  ], (r) => r.brokerId, (r) => r.n);
  const dimensions = [{ key: 'paradas_qtd', value: stalledTotal }];
  for (const s of list) {
    dimensions.push({ key: `estagio:${s.stage}`, value: s.count });
    if (s.avgIdleDays !== null) dimensions.push({ key: `estagio:${s.stage}:media_dias`, value: s.avgIdleDays });
  }
  for (const [broker, count] of [...byBroker.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) dimensions.push({ key: `corretor:${broker}`, value: money.count(count) });
  const details = { total, stalled: stalledTotal, stages: list };
  if (money.cmp(missing, 0) > 0) return degraded('OPORTUNIDADE_SEM_ESTAGIO', { ...details, withoutStage: money.count(missing) }, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const stageRow = (stage, count, stalled = 0, idleDays = 0, brokerId = 'b1') => ({ stage, brokerId, count, stalled, idleDays });
const out = (won, lost, withdrawn = 0, brokerId = 'b1') => ({ brokerId, won, lost, withdrawn });
const ORDER = ['NEW', 'VISIT', 'PROPOSAL', 'WON', 'LOST', 'WITHDRAWN'];
const entry = (stage, count, stalled = '0', avgIdleDays = null) => ({ stage, count, stalled, avgIdleDays });
const dims = (list, stalled, brokers) => [
  { key: 'paradas_qtd', value: stalled },
  ...list.flatMap((s) => [{ key: `estagio:${s.stage}`, value: s.count }, ...(s.avgIdleDays === null ? [] : [{ key: `estagio:${s.stage}:media_dias`, value: s.avgIdleDays }])]),
  ...brokers.map(([id, n]) => ({ key: `corretor:${id}`, value: n })),
];

const emptyList = [entry('WON', '0'), entry('LOST', '0'), entry('WITHDRAWN', '0')];
const singleList = [entry('NEW', '1', '0', '3.0'), entry('WON', '0'), entry('LOST', '0'), entry('WITHDRAWN', '0')];
const typicalList = [entry('NEW', '20', '4', '5.5'), entry('VISIT', '38', '2', '2.0'), entry('PROPOSAL', '12', '0', '1.0'), entry('WON', '6'), entry('LOST', '14'), entry('WITHDRAWN', '0')];
const roundList = [entry('NEW', '3', '0', '0.7'), entry('WON', '0'), entry('LOST', '0'), entry('WITHDRAWN', '0')];

const testCases = [
  {
    kind: 'empty', name: 'sem oportunidades: total 0 e os três estágios terminais zerados', params: { stageOrder: ORDER }, input: { stages: [], outcome: [] },
    expected: { value: '0', status: 'OK', details: { total: '0', stalled: '0', stages: emptyList }, dimensions: dims(emptyList, '0', []) },
  },
  {
    kind: 'single', name: 'uma oportunidade nova há 3 dias', params: { stageOrder: ORDER }, input: { stages: [stageRow('NEW', 1, 0, 3)], outcome: [] },
    expected: { value: '1', status: 'OK', details: { total: '1', stalled: '0', stages: singleList }, dimensions: dims(singleList, '0', [['b1', '1']]) },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: visita 38, proposta 12, ganha 6, perdida 14 (mais 20 novas) na ordem do funil', params: { stageOrder: ORDER },
    input: { stages: [stageRow('PROPOSAL', 12, 0, 12), stageRow('VISIT', 38, 2, 76, 'b2'), stageRow('NEW', 20, 4, 110)], outcome: [out(6, 14)] },
    expected: { value: '90', status: 'OK', details: { total: '90', stalled: '6', stages: typicalList }, dimensions: dims(typicalList, '6', [['b1', '52'], ['b2', '38']]) },
  },
  {
    kind: 'period_edge', name: 'oportunidade sem estágio: DEGRADED e sem valor', params: { stageOrder: ORDER }, input: { stages: [stageRow('', 2), stageRow('NEW', 1)], outcome: [] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'OPORTUNIDADE_SEM_ESTAGIO', total: '1', stalled: '0', stages: [entry('NEW', '1', '0', '0.0'), ...emptyList], withoutStage: '2' },
      dimensions: dims([entry('NEW', '1', '0', '0.0'), ...emptyList], '0', [['b1', '3']]),
    },
  },
  {
    kind: 'rounding', name: 'tempo médio parado: 2 dias em 3 oportunidades => 0,7 dia (meio para cima, 1 casa); estágio fora da ordem vai depois', params: { stageOrder: ORDER },
    input: { stages: [stageRow('NEW', 3, 0, 2)], outcome: [] },
    expected: { value: '3', status: 'OK', details: { total: '3', stalled: '0', stages: roundList }, dimensions: dims(roundList, '0', [['b1', '3']]) },
  },
  {
    kind: 'rounding', name: 'estágio fora da ordem configurada vai depois dos conhecidos e em ordem alfabética', params: { stageOrder: ['NEW'] },
    input: { stages: [stageRow('ZETA', 1), stageRow('ALFA', 1), stageRow('NEW', 1)], outcome: [] },
    expected: (() => {
      const list = [entry('NEW', '1', '0', '0.0'), entry('ALFA', '1', '0', '0.0'), entry('LOST', '0'), entry('WITHDRAWN', '0'), entry('WON', '0'), entry('ZETA', '1', '0', '0.0')];
      return { value: '3', status: 'OK', details: { total: '3', stalled: '0', stages: list }, dimensions: dims(list, '0', [['b1', '3']]) };
    })(),
  },
];

module.exports = { id: 'crm.opportunities_by_stage', version: 1, compute, testCases };
