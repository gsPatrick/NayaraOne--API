'use strict';

/**
 * M9-D624 — KPI fin.anomalies_open (Anomalias abertas), versão 1. Posição no fim do dia-base: casos de anomalia com status aberto, por nível de
 * risco (BAIXO, MEDIO, ALTO), a contagem de risco ALTO separada, por tipo e a idade em dias do mais antigo. Entrada (linha do rm_finance_health):
 * { asOfDate, byRisk: { BAIXO, MEDIO, ALTO, NAO_CLASSIFICADO }, byType: { tipo: n }, oldestDate }. Regra de qualidade: caso sem nível de risco
 * reconhecido é contado em NAO_CLASSIFICADO e o KPI sai DEGRADED com valor nulo (o total só vale com todos os casos classificados).
 */
const money = require('./money');
const { degraded, ageDays } = require('./_finKpi');

const LEVELS = ['BAIXO', 'MEDIO', 'ALTO', 'NAO_CLASSIFICADO'];

function compute(input) {
  const byRisk = Object.fromEntries(LEVELS.map((l) => [l, money.count((input.byRisk || {})[l] || 0)]));
  const total = money.count(money.sum(LEVELS.map((l) => byRisk[l])));
  const oldestAgeDays = ageDays(input.oldestDate, input.asOfDate);
  const dimensions = [{ key: 'alto', value: byRisk.ALTO }];
  for (const level of LEVELS) dimensions.push({ key: `risco:${level}`, value: byRisk[level] });
  for (const type of Object.keys(input.byType || {}).sort()) dimensions.push({ key: `tipo:${type}`, value: money.count(input.byType[type]) });
  if (oldestAgeDays !== null) dimensions.push({ key: 'mais_antiga_dias', value: oldestAgeDays });
  const details = { total, high: byRisk.ALTO, byRisk, oldestAgeDays };
  if (byRisk.NAO_CLASSIFICADO !== '0') return degraded('CASO_SEM_NIVEL_DE_RISCO', { ...details, unclassified: byRisk.NAO_CLASSIFICADO }, dimensions);
  return { value: total, status: 'OK', details, dimensions };
}

const input = (extra = {}) => ({ asOfDate: '2026-10-28', byRisk: { BAIXO: 1, MEDIO: 2, ALTO: 2, NAO_CLASSIFICADO: 0 }, byType: { DUPLICATE: 3, ROUND_AMOUNT: 2 }, oldestDate: '2026-10-20', ...extra });
const okOf = (byRisk, total, high, oldest, dims) => ({ value: total, status: 'OK', details: { total, high, byRisk, oldestAgeDays: oldest }, dimensions: dims });
const risks = (b, m, a, n = '0') => ({ BAIXO: b, MEDIO: m, ALTO: a, NAO_CLASSIFICADO: n });
const riskDims = (b, m, a, n = '0') => [{ key: 'alto', value: a }, { key: 'risco:BAIXO', value: b }, { key: 'risco:MEDIO', value: m }, { key: 'risco:ALTO', value: a }, { key: 'risco:NAO_CLASSIFICADO', value: n }];

const testCases = [
  { kind: 'empty', name: 'nenhuma anomalia aberta', input: input({ byRisk: risks(0, 0, 0), byType: {}, oldestDate: null }), expected: okOf(risks('0', '0', '0'), '0', '0', null, riskDims('0', '0', '0')) },
  {
    kind: 'single', name: 'um caso de risco alto', input: input({ byRisk: risks(0, 0, 1), byType: { DUPLICATE: 1 }, oldestDate: '2026-10-28' }),
    expected: okOf(risks('0', '0', '1'), '1', '1', '0', [...riskDims('0', '0', '1'), { key: 'tipo:DUPLICATE', value: '1' }, { key: 'mais_antiga_dias', value: '0' }]),
  },
  {
    kind: 'typical', name: 'exemplo da demanda: 5 abertas, 2 ALTO, 2 MEDIO, 1 BAIXO', input: input(),
    expected: okOf(risks('1', '2', '2'), '5', '2', '8', [...riskDims('1', '2', '2'), { key: 'tipo:DUPLICATE', value: '3' }, { key: 'tipo:ROUND_AMOUNT', value: '2' }, { key: 'mais_antiga_dias', value: '8' }]),
  },
  {
    kind: 'period_edge', name: 'caso aberto no próprio dia-base tem idade 0 e virada de mês conta dias corridos', input: input({ asOfDate: '2026-11-01', oldestDate: '2026-10-31', byType: {} }),
    expected: okOf(risks('1', '2', '2'), '5', '2', '1', [...riskDims('1', '2', '2'), { key: 'mais_antiga_dias', value: '1' }]),
  },
  {
    kind: 'period_edge', name: 'caso sem nível de risco: DEGRADED, sem valor e contado em NAO_CLASSIFICADO', input: input({ byRisk: risks(1, 2, 2, 1), byType: {}, oldestDate: null }),
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'CASO_SEM_NIVEL_DE_RISCO', total: '6', high: '2', byRisk: risks('1', '2', '2', '1'), oldestAgeDays: null, unclassified: '1' }, dimensions: riskDims('1', '2', '2', '1'),
    },
  },
  {
    kind: 'rounding', name: 'contagem é inteira: texto numérico entra como número e sai sem casas', input: input({ byRisk: { BAIXO: '3', MEDIO: '0', ALTO: '4', NAO_CLASSIFICADO: '0' }, byType: {}, oldestDate: null }),
    expected: okOf(risks('3', '0', '4'), '7', '4', null, riskDims('3', '0', '4')),
  },
];

module.exports = { id: 'fin.anomalies_open', version: 1, compute, testCases };
