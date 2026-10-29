'use strict';

/**
 * M9-D681 — KPI ai.quality_scores (Grounding e evaluation score), versão 1. Posição na semana de São Paulo (segunda a domingo) da data-base: grounding = execuções com fonte ÷ execuções
 * com fundamentação aplicável × 100 (2 casas), por agente e semana; evaluation = média das notas dos itens das avaliações da semana na escala de 0 a 100 (1 casa); respostas
 * bloqueadas por grounding (aplicáveis sem fonte suficiente) contadas à parte. Exemplo: 940 de 1.000 => 94,00%. Entrada (rm_ai_quality): { rows: [{ agent, week, runs, groundingRuns,
 * groundingScoreSum, evalItems, evalScoreSum }], week }. Parâmetro: minSample. Regra de qualidade: menos de `minSample` execuções na semana -> INCOMPLETE e sem valor; agente (ou semana do
 * histórico) abaixo da amostra fica de fora das dimensões e é listado.
 */
const money = require('./money');
const { incomplete, sumCounts } = require('./_legalCorKpi');
const { safe, total, distinct } = require('./_aiKpi');

const DEFAULT_MIN_SAMPLE = 5;

function scoresOf(rows, minSample) {
  const runs = sumCounts(rows.map((r) => r.runs));
  const applicable = sumCounts(rows.map((r) => r.groundingRuns));
  const items = sumCounts(rows.map((r) => r.evalItems));
  const sum = total(rows, (r) => r.groundingScoreSum);
  const evalSum = total(rows, (r) => r.evalScoreSum);
  return {
    runs, applicable, items, enough: money.cmp(runs, minSample) >= 0,
    grounding: money.cmp(applicable, 0) > 0 ? money.percent(sum, applicable).value : null,
    blocked: money.count(money.sub(applicable, sum)),
    evaluation: money.cmp(items, 0) > 0 ? money.round(money.div(money.mul(evalSum, 100), items), 1) : null,
  };
}

function pushScores(dimensions, prefix, s) {
  if (s.grounding !== null) dimensions.push({ key: prefix, value: s.grounding });
  if (s.evaluation !== null) dimensions.push({ key: `${prefix}:avaliacao_nota`, value: s.evaluation });
}

function compute(input, params = {}) {
  const rows = input.rows || [];
  const minSample = params.minSample ?? DEFAULT_MIN_SAMPLE;
  const current = rows.filter((r) => r.week === input.week);
  const week = scoresOf(current, minSample);
  if (!week.enough) return incomplete('AMOSTRA_INSUFICIENTE', { week: input.week, runs: week.runs, minSample: String(minSample) });
  if (week.grounding === null) return incomplete('SEM_FUNDAMENTACAO_APLICAVEL', { week: input.week, runs: week.runs });
  const dimensions = [];
  if (week.evaluation !== null) dimensions.push({ key: 'avaliacao_nota', value: week.evaluation });
  dimensions.push({ key: 'bloqueadas_grounding_qtd', value: week.blocked });
  const insufficientAgents = [];
  for (const agent of distinct(current.map((r) => r.agent))) {
    const s = scoresOf(current.filter((r) => r.agent === agent), minSample);
    if (!s.enough) { insufficientAgents.push(agent); continue; }
    if (s.grounding !== null) dimensions.push({ key: `agente:${safe(agent)}`, value: s.grounding });
    if (s.evaluation !== null) dimensions.push({ key: `agente:${safe(agent)}:avaliacao_nota`, value: s.evaluation });
    dimensions.push({ key: `agente:${safe(agent)}:bloqueadas_grounding_qtd`, value: s.blocked }, { key: `agente:${safe(agent)}:execucoes_qtd`, value: s.runs });
  }
  const weeksBelowSample = [];
  for (const w of distinct(rows.map((r) => r.week))) {
    const s = scoresOf(rows.filter((r) => r.week === w), minSample);
    if (!s.enough) { weeksBelowSample.push(w); continue; }
    pushScores(dimensions, `semana:${w}`, s);
  }
  const details = { week: input.week, runs: week.runs, groundingRuns: week.applicable, blockedByGrounding: week.blocked, evaluation: week.evaluation, insufficientAgents, weeksBelowSample };
  return { value: week.grounding, status: 'OK', details, dimensions };
}

const row = (agent, week, runs, groundingRuns, groundingScoreSum, evalItems = 0, evalScoreSum = '0') => ({ agent, week, runs, groundingRuns, groundingScoreSum, evalItems, evalScoreSum });
const W = '2026-10-26';

const testCases = [
  { kind: 'empty', name: 'nenhuma execução na semana: INCOMPLETE por amostra insuficiente', input: { rows: [], week: W }, params: { minSample: 5 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'AMOSTRA_INSUFICIENTE', week: '2026-10-26', runs: '0', minSample: '5' }, dimensions: [] } },
  { kind: 'single', name: 'uma execução (amostra mínima de 1): 100,00%', input: { rows: [row('NAY_COMERCIAL', W, 1, 1, '1.0000')], week: W }, params: { minSample: 1 }, expected: { value: '100.00', status: 'OK', details: { week: '2026-10-26', runs: '1', groundingRuns: '1', blockedByGrounding: '0', evaluation: null, insufficientAgents: [], weeksBelowSample: [] }, dimensions: [{ key: 'bloqueadas_grounding_qtd', value: '0' }, { key: 'agente:NAY_COMERCIAL', value: '100.00' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_grounding_qtd', value: '0' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '1' }, { key: 'semana:2026-10-26', value: '100.00' }] } },
  {
    kind: 'typical', name: 'exemplo do livro: 940 de 1.000 afirmações => 94,00%, 60 bloqueadas por grounding; avaliação média 58,3',
    input: { rows: [row('NAY_COMERCIAL', W, 1000, 1000, '940.0000', 3, '1.7500')], week: W }, params: { minSample: 5 }, expected: { value: '94.00', status: 'OK', details: { week: '2026-10-26', runs: '1000', groundingRuns: '1000', blockedByGrounding: '60', evaluation: '58.3', insufficientAgents: [], weeksBelowSample: [] }, dimensions: [{ key: 'avaliacao_nota', value: '58.3' }, { key: 'bloqueadas_grounding_qtd', value: '60' }, { key: 'agente:NAY_COMERCIAL', value: '94.00' }, { key: 'agente:NAY_COMERCIAL:avaliacao_nota', value: '58.3' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_grounding_qtd', value: '60' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '1000' }, { key: 'semana:2026-10-26', value: '94.00' }, { key: 'semana:2026-10-26:avaliacao_nota', value: '58.3' }] },
  },
  {
    kind: 'period_edge', name: 'agente com amostra abaixo do mínimo fica fora das dimensões (e listado) e a semana anterior pequena fica fora do histórico',
    input: { rows: [row('NAY_COMERCIAL', W, 8, 8, '6.0000'), row('NAY_FINANCEIRO', W, 2, 2, '2.0000'), row('NAY_COMERCIAL', '2026-10-19', 1, 1, '1.0000')], week: W }, params: { minSample: 5 }, expected: { value: '80.00', status: 'OK', details: { week: '2026-10-26', runs: '10', groundingRuns: '10', blockedByGrounding: '2', evaluation: null, insufficientAgents: ['NAY_FINANCEIRO'], weeksBelowSample: ['2026-10-19'] }, dimensions: [{ key: 'bloqueadas_grounding_qtd', value: '2' }, { key: 'agente:NAY_COMERCIAL', value: '75.00' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_grounding_qtd', value: '2' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '8' }, { key: 'semana:2026-10-26', value: '80.00' }] },
  },
  {
    kind: 'rounding', name: 'grounding e avaliação arredondados uma vez (meio para cima): 2 de 3 => 66,67%; histórico de duas semanas',
    input: { rows: [row('NAY_COMERCIAL', W, 6, 3, '2.0000', 3, '1.7500'), row('NAY_COMERCIAL', '2026-10-19', 6, 6, '5.0000')], week: W }, params: { minSample: 5 }, expected: { value: '66.67', status: 'OK', details: { week: '2026-10-26', runs: '6', groundingRuns: '3', blockedByGrounding: '1', evaluation: '58.3', insufficientAgents: [], weeksBelowSample: [] }, dimensions: [{ key: 'avaliacao_nota', value: '58.3' }, { key: 'bloqueadas_grounding_qtd', value: '1' }, { key: 'agente:NAY_COMERCIAL', value: '66.67' }, { key: 'agente:NAY_COMERCIAL:avaliacao_nota', value: '58.3' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_grounding_qtd', value: '1' }, { key: 'agente:NAY_COMERCIAL:execucoes_qtd', value: '6' }, { key: 'semana:2026-10-19', value: '83.33' }, { key: 'semana:2026-10-26', value: '66.67' }, { key: 'semana:2026-10-26:avaliacao_nota', value: '58.3' }] },
  },
  { kind: 'rounding', name: 'semana só com respostas sem fundamentação aplicável: INCOMPLETE', input: { rows: [row('NAY_COMERCIAL', W, 9, 0, '0')], week: W }, params: { minSample: 5 }, expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'SEM_FUNDAMENTACAO_APLICAVEL', week: '2026-10-26', runs: '9' }, dimensions: [] } },
];

module.exports = { id: 'ai.quality_scores', version: 1, compute, testCases };
