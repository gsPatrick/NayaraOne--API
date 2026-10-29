'use strict';

/**
 * M9-D641 — KPI rent.obligations_pending (Obrigações pendentes), versão 1. Posição no fim do dia-base: contagem de obrigações abertas (exigências documentais pendentes e trocas de
 * titularidade de conta sem comprovante) de contratos de locação não encerrados, com as vencidas separadas (prazo = início do contrato, antes de hoje), as a vencer e a idade, em dias
 * de calendário de São Paulo, da vencida mais antiga. O valor é o total de abertas. Entrada (rm_rental_obligations): { rows: [{ kind, pending, overdue, withoutDeadline,
 * oldestOverdueDays }] }. Regra de qualidade: obrigação sem prazo -> DEGRADED; contagem ainda não calculada pelo read model (nula) -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded, sumCounts, byText } = require('./_legalCorKpi');

const oldestOf = (rows) => {
  const days = rows.map((r) => r.oldestOverdueDays).filter((d) => d !== null && d !== undefined);
  return days.length ? money.count(days.reduce((a, d) => (money.cmp(d, a) > 0 ? d : a))) : null;
};

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => r.withoutDeadline === null || r.withoutDeadline === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const open = sumCounts(rows.map((r) => r.pending));
  const withoutDeadline = sumCounts(rows.map((r) => r.withoutDeadline));
  if (money.cmp(withoutDeadline, 0) > 0) return degraded('OBRIGACAO_SEM_PRAZO', { open, withoutDeadline });
  const overdue = sumCounts(rows.map((r) => r.overdue));
  const upcoming = money.count(money.sub(open, overdue));
  const oldest = oldestOf(rows);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort(byText).map((kind) => {
    const own = rows.filter((r) => r.kind === kind);
    return { kind, open: sumCounts(own.map((r) => r.pending)), overdue: sumCounts(own.map((r) => r.overdue)) };
  });
  const dimensions = [{ key: 'vencidas_qtd', value: overdue }, { key: 'a_vencer_qtd', value: upcoming }];
  if (oldest !== null) dimensions.push({ key: 'mais_antiga_dias', value: oldest });
  for (const k of kinds) dimensions.push({ key: `tipo:${k.kind}:abertas_qtd`, value: k.open }, { key: `tipo:${k.kind}:vencidas_qtd`, value: k.overdue });
  return { value: open, status: 'OK', details: { open, overdue, upcoming, oldestOverdueDays: oldest, byKind: kinds }, dimensions };
}

const row = (kind, pending, overdue, oldest = null, withoutDeadline = 0) => ({ kind, pending, overdue, withoutDeadline, oldestOverdueDays: oldest });
const kindOf = (kind, open, overdue) => ({ kind, open, overdue });
const okOf = (open, overdue, upcoming, oldest, byKind) => ({
  value: open, status: 'OK', details: { open, overdue, upcoming, oldestOverdueDays: oldest, byKind },
  dimensions: [{ key: 'vencidas_qtd', value: overdue }, { key: 'a_vencer_qtd', value: upcoming }, ...(oldest === null ? [] : [{ key: 'mais_antiga_dias', value: oldest }]),
    ...byKind.flatMap((k) => [{ key: `tipo:${k.kind}:abertas_qtd`, value: k.open }, { key: `tipo:${k.kind}:vencidas_qtd`, value: k.overdue }])],
});
const bad = (reason, details) => ({ value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma obrigação aberta: zero e sem idade', input: { rows: [] }, expected: okOf('0', '0', '0', null, []) },
  { kind: 'single', name: 'uma exigência vencida há 3 dias', input: { rows: [row('REQUIREMENT', 1, 1, 3)] }, expected: okOf('1', '1', '0', '3', [kindOf('REQUIREMENT', '1', '1')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 23 abertas, 5 vencidas, a mais antiga com 12 dias', input: { rows: [row('REQUIREMENT', 15, 3, 12), row('UTILITY', 8, 2, 7)] },
    expected: okOf('23', '5', '18', '12', [kindOf('REQUIREMENT', '15', '3'), kindOf('UTILITY', '8', '2')]),
  },
  { kind: 'period_edge', name: 'obrigação sem prazo: DEGRADED e sem valor', input: { rows: [row('REQUIREMENT', 4, 1, 2, 1), row('UTILITY', 2, 0, null, 0)] }, expected: bad('OBRIGACAO_SEM_PRAZO', { open: '6', withoutDeadline: '1' }) },
  {
    kind: 'rounding', name: 'contagens grandes somam exatas (sem ponto flutuante)', input: { rows: [row('REQUIREMENT', '9007199254740993', 0), row('UTILITY', 1, 0)] },
    expected: okOf('9007199254740994', '0', '9007199254740994', null, [kindOf('REQUIREMENT', '9007199254740993', '0'), kindOf('UTILITY', '1', '0')]),
  },
  { kind: 'period_edge', name: 'contagem de obrigações sem prazo ainda não calculada pelo read model: DEGRADED e sem valor', input: { rows: [row('REQUIREMENT', 4, 1, 2, null)] }, expected: bad('READ_MODEL_NAO_RECALCULADO', {}) },
];

module.exports = { id: 'rent.obligations_pending', version: 1, compute, testCases };
