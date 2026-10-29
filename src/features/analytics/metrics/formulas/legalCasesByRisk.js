'use strict';

/**
 * M9-D660 — KPI legal.cases_by_risk (Processos por risco), versão 1. Posição no fim do dia-base: contagem de processos ATIVOS por nível de risco e por
 * tipo de processo (rm_legal_cases_risk); processo sem nível entra em "Sem classificação" (SEM_CLASSIFICACAO). O valor é o total de processos ativos.
 * Entrada: { rows: [{ risk, type, count }] }. Parâmetro: maxNoRiskPct (analytics.qualidade.max_sem_risco_pct, padrão 10). Regra de qualidade: sem
 * classificação acima do limite -> DEGRADED, valor nulo. Contagens inteiras e percentuais em decimal exato, arredondados uma só vez (2 casas).
 */
const money = require('./money');
const { degraded, exceedsPct, groupCount, byValueDesc, sumCounts, NO_RISK } = require('./_legalCorKpi');

function compute(input, params = {}) {
  const maxNoRiskPct = Number.isInteger(params.maxNoRiskPct) ? params.maxNoRiskPct : 10;
  const rows = input.rows || [];
  const total = sumCounts(rows.map((r) => r.count));
  const byRisk = groupCount(rows, (r) => r.risk, (r) => r.count);
  const byType = groupCount(rows, (r) => r.type, (r) => r.count);
  const none = byRisk.get(NO_RISK) || '0';
  const list = byValueDesc(byRisk).map(([risk, count]) => ({ risk, count, percent: money.percent(count, total).value }));
  const details = { total, byRisk: list, withoutClassification: none, withoutClassificationPct: money.percent(none, total).value };
  if (money.cmp(total, 0) > 0 && exceedsPct(none, total, maxNoRiskPct)) return degraded('SEM_CLASSIFICACAO_ACIMA_DO_LIMITE', { ...details, maxNoRiskPct: String(maxNoRiskPct) });
  const dimensions = [...list.map((r) => ({ key: `risco:${r.risk}`, value: r.count })), ...byValueDesc(byType).map(([type, count]) => ({ key: `tipo:${type}`, value: count }))];
  return { value: total, status: 'OK', details, dimensions };
}

const row = (risk, type, count) => ({ risk, type, count });
const r = (risk, count, percent) => ({ risk, count, percent });
const okOf = (total, list, none, nonePct, dims) => ({ value: total, status: 'OK', details: { total, byRisk: list, withoutClassification: none, withoutClassificationPct: nonePct }, dimensions: dims });
const dimsOf = (risks, types) => [...risks.map(([k, n]) => ({ key: `risco:${k}`, value: n })), ...types.map(([k, n]) => ({ key: `tipo:${k}`, value: n }))];

const testCases = [
  { kind: 'empty', name: 'nenhum processo ativo: total 0, sem percentuais', input: { rows: [] }, expected: okOf('0', [], '0', null, []) },
  { kind: 'single', name: 'um processo de risco alto: 100,00%', input: { rows: [row('HIGH', 'EVICTION', 1)] }, expected: okOf('1', [r('HIGH', '1', '100.00')], '0', '0.00', dimsOf([['HIGH', '1']], [['EVICTION', '1']])) },
  {
    kind: 'typical', name: 'exemplo da demanda: alto 3, médio 8, baixo 14 (limite elevado a 20%, 2 sem classificação)', params: { maxNoRiskPct: 20 },
    input: { rows: [row('HIGH', 'EVICTION', 3), row('MEDIUM', 'LABOR', 5), row('MEDIUM', 'EVICTION', 3), row('LOW', 'LABOR', 14), row(NO_RISK, 'LABOR', 2)] },
    expected: okOf('27', [r('LOW', '14', '51.85'), r('MEDIUM', '8', '29.63'), r('HIGH', '3', '11.11'), r(NO_RISK, '2', '7.41')], '2', '7.41',
      dimsOf([['LOW', '14'], ['MEDIUM', '8'], ['HIGH', '3'], [NO_RISK, '2']], [['LABOR', '21'], ['EVICTION', '6']])),
  },
  {
    kind: 'period_edge', name: 'sem classificação exatamente no limite (10%) não rebaixa; um acima rebaixa', input: { rows: [row('HIGH', 'LABOR', 9), row(NO_RISK, 'LABOR', 1)] },
    expected: okOf('10', [r('HIGH', '9', '90.00'), r(NO_RISK, '1', '10.00')], '1', '10.00', dimsOf([['HIGH', '9'], [NO_RISK, '1']], [['LABOR', '10']])),
  },
  {
    kind: 'rounding', name: 'três níveis iguais: 33,33% cada', input: { rows: [row('A', 'T', 1), row('B', 'T', 1), row('C', 'T', 1)] },
    expected: okOf('3', [r('A', '1', '33.33'), r('B', '1', '33.33'), r('C', '1', '33.33')], '0', '0.00', dimsOf([['A', '1'], ['B', '1'], ['C', '1']], [['T', '3']])),
  },
  {
    kind: 'period_edge', name: 'sem classificação acima do limite (2 de 10 com limite 10%): DEGRADED e sem valor', input: { rows: [row('HIGH', 'LABOR', 8), row(NO_RISK, 'LABOR', 2)] },
    expected: {
      value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'SEM_CLASSIFICACAO_ACIMA_DO_LIMITE', total: '10', byRisk: [r('HIGH', '8', '80.00'), r(NO_RISK, '2', '20.00')], withoutClassification: '2', withoutClassificationPct: '20.00', maxNoRiskPct: '10' }, dimensions: [],
    },
  },
];

module.exports = { id: 'legal.cases_by_risk', version: 1, compute, testCases };
