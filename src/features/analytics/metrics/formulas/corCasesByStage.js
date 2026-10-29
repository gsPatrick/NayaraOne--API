'use strict';

/**
 * M9-D661 — KPI cor.cases_by_stage (Financing cases por estágio), versão 1. Posição no fim do dia-base: contagem de casos de financiamento por
 * estágio (o status do caso) e o tempo médio no estágio atual, em dias de calendário de São Paulo com 1 casa. O valor é o total de casos. Caso fora
 * de um estágio válido (lista do parâmetro analytics.correspondente.estagios_validos) é contado em details.invalid sem sair do total. Entrada
 * (rm_fin_cases_stage): { rows: [{ stage, count, daysSum }] }. Regra de qualidade: caso sem estágio -> DEGRADED, valor nulo.
 */
const money = require('./money');
const { degraded, sumCounts, byText } = require('./_legalCorKpi');

function compute(input, params = {}) {
  const valid = Array.isArray(params.validStages) ? params.validStages : [];
  const rows = (input.rows || []).map((r) => ({ stage: String(r.stage === undefined || r.stage === null ? '' : r.stage).trim(), count: money.count(r.count || 0), daysSum: money.count(r.daysSum || 0) }));
  const total = sumCounts(rows.map((r) => r.count));
  const none = sumCounts(rows.filter((r) => r.stage === '').map((r) => r.count));
  if (money.cmp(none, 0) > 0) return degraded('CASO_SEM_ESTAGIO', { total, withoutStage: none });
  const rank = (stage) => (valid.includes(stage) ? valid.indexOf(stage) : valid.length);
  const ordered = [...rows].sort((a, b) => rank(a.stage) - rank(b.stage) || byText(a.stage, b.stage));
  const byStage = ordered.map((r) => ({ stage: r.stage, count: r.count, avgDays: money.round(money.div(r.daysSum, r.count), 1) }));
  const invalid = ordered.filter((r) => !valid.includes(r.stage));
  const dimensions = byStage.flatMap((s) => [{ key: `estagio:${s.stage}`, value: s.count }, { key: `estagio:${s.stage}:tempo_medio_dias`, value: s.avgDays }]);
  return { value: total, status: 'OK', details: { total, byStage, invalid: { count: sumCounts(invalid.map((r) => r.count)), stages: invalid.map((r) => r.stage) } }, dimensions };
}

const VALID = ['LEVANTAMENTO', 'ANALISE', 'APROVADO'];
const row = (stage, count, daysSum) => ({ stage, count, daysSum });
const s = (stage, count, avgDays) => ({ stage, count, avgDays });
const okOf = (total, list, invalidCount, invalidStages) => ({
  value: total, status: 'OK', details: { total, byStage: list, invalid: { count: invalidCount, stages: invalidStages } },
  dimensions: list.flatMap((x) => [{ key: `estagio:${x.stage}`, value: x.count }, { key: `estagio:${x.stage}:tempo_medio_dias`, value: x.avgDays }]),
});

const testCases = [
  { kind: 'empty', name: 'nenhum caso: total 0', params: { validStages: VALID }, input: { rows: [] }, expected: okOf('0', [], '0', []) },
  { kind: 'single', name: 'um caso em análise há 4 dias', params: { validStages: VALID }, input: { rows: [row('ANALISE', 1, 4)] }, expected: okOf('1', [s('ANALISE', '1', '4.0')], '0', []) },
  {
    kind: 'typical', name: 'exemplo da demanda: levantamento 6, análise 18, aprovado 5, na ordem do fluxo', params: { validStages: VALID },
    input: { rows: [row('APROVADO', 5, 10), row('ANALISE', 18, 135), row('LEVANTAMENTO', 6, 9)] },
    expected: okOf('29', [s('LEVANTAMENTO', '6', '1.5'), s('ANALISE', '18', '7.5'), s('APROVADO', '5', '2.0')], '0', []),
  },
  {
    kind: 'period_edge', name: 'estágio fora da lista válida entra no total e em details.invalid, depois dos válidos', params: { validStages: VALID },
    input: { rows: [row('XPTO', 2, 0), row('ANALISE', 1, 0)] }, expected: okOf('3', [s('ANALISE', '1', '0.0'), s('XPTO', '2', '0.0')], '2', ['XPTO']),
  },
  { kind: 'rounding', name: 'tempo médio com meio dia arredonda para cima numa só vez (1 dia em 8 casos = 0,1; 5 em 8 = 0,6)', params: { validStages: VALID }, input: { rows: [row('ANALISE', 8, 5)] }, expected: okOf('8', [s('ANALISE', '8', '0.6')], '0', []) },
  {
    kind: 'period_edge', name: 'caso sem estágio: DEGRADED e sem valor', params: { validStages: VALID }, input: { rows: [row('', 1, 0), row('ANALISE', 2, 2)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'CASO_SEM_ESTAGIO', total: '3', withoutStage: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'cor.cases_by_stage', version: 1, compute, testCases };
