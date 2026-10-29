'use strict';

/**
 * M9-D631 — KPI crm.portfolio_without_next_action (Carteira sem próxima ação), versão 1. Posição no fim do dia-base: contagem e percentual das
 * oportunidades em aberto (fora de CLOSED_WON, CLOSED_LOST e WITHDRAWN) sem próxima ação válida, isto é, sem tarefa aberta com data posterior a hoje e sem
 * nextAction preenchida conforme opportunityNextAction.validator.js (texto e data). Percentual = sem ação / em aberto x 100 (2 casas, uma vez).
 * Entrada (rm_crm_next_action): { rows: [{ brokerId, openTotal, without, byStage: { estágio: { open, without } } }] }. Parâmetro: maxNoBrokerPct.
 * Regra de qualidade: oportunidade em aberto sem corretor acima do limite (padrão 0) -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, exceedsPct, groupSum, NO_BROKER } = require('./_crmKpi');

function stageTotals(rows) {
  const open = new Map();
  const without = new Map();
  for (const row of rows) {
    for (const [name, cell] of Object.entries(row.byStage || {})) {
      const stage = name.trim().toUpperCase();
      open.set(stage, money.toString(money.add(open.get(stage) || '0', cell.open || 0)));
      without.set(stage, money.toString(money.add(without.get(stage) || '0', cell.without || 0)));
    }
  }
  return { open, without };
}

function compute(input, params = {}) {
  const maxNoBrokerPct = Number.isInteger(params.maxNoBrokerPct) ? params.maxNoBrokerPct : 0;
  const rows = input.rows || [];
  const open = money.count(money.sum(rows.map((r) => r.openTotal || 0)));
  const without = money.count(money.sum(rows.map((r) => r.without || 0)));
  const openWithoutBroker = money.count(money.sum(rows.filter((r) => r.brokerId === NO_BROKER).map((r) => r.openTotal || 0)));
  const percent = money.percent(without, open).value;
  const byBroker = groupSum(rows, (r) => r.brokerId, (r) => r.without);
  const stages = stageTotals(rows);
  const dimensions = [{ key: 'em_aberto_qtd', value: open }];
  if (percent !== null) dimensions.push({ key: 'sem_acao_pct', value: percent });
  for (const [broker, count] of [...byBroker.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) dimensions.push({ key: `corretor:${broker}`, value: money.count(count) });
  for (const stage of [...stages.open.keys()].sort()) {
    dimensions.push({ key: `estagio:${stage}`, value: money.count(stages.without.get(stage)) }, { key: `estagio:${stage}:em_aberto_qtd`, value: money.count(stages.open.get(stage)) });
  }
  const details = { open, without, percent, withoutBroker: openWithoutBroker };
  if (money.cmp(open, 0) > 0 && exceedsPct(openWithoutBroker, open, maxNoBrokerPct)) return degraded('OPORTUNIDADE_EM_ABERTO_SEM_CORRETOR', details, dimensions);
  return { value: without, status: 'OK', details, dimensions };
}

const NB = '00000000-0000-0000-0000-000000000000';
const row = (brokerId, openTotal, without, byStage) => ({ brokerId, openTotal, without, byStage });
const cell = (open, without) => ({ open, without });
const dims = (open, pct, brokers, stages) => [
  { key: 'em_aberto_qtd', value: open }, ...(pct === null ? [] : [{ key: 'sem_acao_pct', value: pct }]),
  ...brokers.map(([id, n]) => ({ key: `corretor:${id}`, value: n })),
  ...stages.flatMap(([s, w, o]) => [{ key: `estagio:${s}`, value: w }, { key: `estagio:${s}:em_aberto_qtd`, value: o }]),
];

const testCases = [
  { kind: 'empty', name: 'carteira vazia: 0 sem ação e sem percentual', input: { rows: [] }, expected: { value: '0', status: 'OK', details: { open: '0', without: '0', percent: null, withoutBroker: '0' }, dimensions: dims('0', null, [], []) } },
  {
    kind: 'single', name: 'uma oportunidade em aberto sem ação: 100,00%', input: { rows: [row('b1', 1, 1, { NEW: cell(1, 1) })] },
    expected: { value: '1', status: 'OK', details: { open: '1', without: '1', percent: '100.00', withoutBroker: '0' }, dimensions: dims('1', '100.00', [['b1', '1']], [['NEW', '1', '1']]) },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 92 em aberto, 17 sem ação => 17 e 18,48%',
    input: { rows: [row('b1', 60, 10, { NEW: cell(40, 6), VISIT: cell(20, 4) }), row('b2', 32, 7, { NEW: cell(32, 7) })] },
    expected: { value: '17', status: 'OK', details: { open: '92', without: '17', percent: '18.48', withoutBroker: '0' }, dimensions: dims('92', '18.48', [['b1', '10'], ['b2', '7']], [['NEW', '13', '72'], ['VISIT', '4', '20']]) },
  },
  {
    kind: 'period_edge', name: 'oportunidade em aberto sem corretor: DEGRADED e sem valor', input: { rows: [row('b1', 9, 2, { NEW: cell(9, 2) }), row(NB, 1, 1, { NEW: cell(1, 1) })] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'OPORTUNIDADE_EM_ABERTO_SEM_CORRETOR', open: '10', without: '3', percent: '30.00', withoutBroker: '1' },
      dimensions: dims('10', '30.00', [[NB, '1'], ['b1', '2']], [['NEW', '3', '10']]),
    },
  },
  {
    kind: 'rounding', name: '1 de 3 em aberto => 33,33%; 2 de 3 => 66,67% (meio para cima)', input: { rows: [row('b1', 3, 2, { NEW: cell(3, 2) })] },
    expected: { value: '2', status: 'OK', details: { open: '3', without: '2', percent: '66.67', withoutBroker: '0' }, dimensions: dims('3', '66.67', [['b1', '2']], [['NEW', '2', '3']]) },
  },
  {
    kind: 'rounding', name: 'o limite de oportunidades sem corretor é configurável: 1 de 10 passa com 10%', params: { maxNoBrokerPct: 10 },
    input: { rows: [row('b1', 9, 0, { NEW: cell(9, 0) }), row(NB, 1, 0, { NEW: cell(1, 0) })] },
    expected: { value: '0', status: 'OK', details: { open: '10', without: '0', percent: '0.00', withoutBroker: '1' }, dimensions: dims('10', '0.00', [[NB, '0'], ['b1', '0']], [['NEW', '0', '10']]) },
  },
];

module.exports = { id: 'crm.portfolio_without_next_action', version: 1, compute, testCases };
