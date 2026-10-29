'use strict';

/**
 * M9-D641 — KPI rent.guarantees_expiring (Garantias vencendo), versão 1. Posição no fim do dia-base: contagem de garantias ativas de contratos de locação ACTIVE com vencimento de
 * hoje até hoje+29 (30 dias), de hoje até hoje+59 (60 dias, acumulado) e já vencidas (antes de hoje), por tipo de garantia. O valor é a contagem dos 30 dias; as outras faixas vão em
 * details e nas dimensões. Entrada (rm_rental_guarantees): { rows: [{ type, expiring30, expiring60, expired, withoutDate }] }. Regra de qualidade: garantia sem data de vencimento
 * (fora os tipos sem vencimento, já excluídos do read model) -> INCOMPLETE; contagem ainda não calculada pelo read model (nula) -> DEGRADED. Valor sempre nulo nesses casos.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts, byText } = require('./_legalCorKpi');

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => r.withoutDate === null || r.withoutDate === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const withoutDate = sumCounts(rows.map((r) => r.withoutDate));
  if (money.cmp(withoutDate, 0) > 0) return incomplete('GARANTIA_SEM_VENCIMENTO', { withoutDate });
  const total = (field) => sumCounts(rows.map((r) => r[field]));
  const [in30, in60, expired] = [total('expiring30'), total('expiring60'), total('expired')];
  const types = [...new Set(rows.map((r) => r.type))].sort(byText);
  const byType = types.map((type) => {
    const own = rows.filter((r) => r.type === type);
    return { type, expiring30d: sumCounts(own.map((r) => r.expiring30)), expiring60d: sumCounts(own.map((r) => r.expiring60)), expired: sumCounts(own.map((r) => r.expired)) };
  });
  const dimensions = [{ key: 'vencendo_30d_qtd', value: in30 }, { key: 'vencendo_60d_qtd', value: in60 }, { key: 'vencidas_qtd', value: expired }];
  for (const t of byType) dimensions.push({ key: `tipo:${t.type}:vencendo_30d_qtd`, value: t.expiring30d }, { key: `tipo:${t.type}:vencendo_60d_qtd`, value: t.expiring60d }, { key: `tipo:${t.type}:vencidas_qtd`, value: t.expired });
  return { value: in30, status: 'OK', details: { expiring30d: in30, expiring60d: in60, expired, byType }, dimensions };
}

const row = (type, expiring30, expiring60, expired, withoutDate = 0) => ({ type, expiring30, expiring60, expired, withoutDate });
const typed = (type, a, b, c) => ({ type, expiring30d: a, expiring60d: b, expired: c });
const okOf = (a, b, c, byType) => ({
  value: a, status: 'OK', details: { expiring30d: a, expiring60d: b, expired: c, byType },
  dimensions: [{ key: 'vencendo_30d_qtd', value: a }, { key: 'vencendo_60d_qtd', value: b }, { key: 'vencidas_qtd', value: c },
    ...byType.flatMap((t) => [{ key: `tipo:${t.type}:vencendo_30d_qtd`, value: t.expiring30d }, { key: `tipo:${t.type}:vencendo_60d_qtd`, value: t.expiring60d }, { key: `tipo:${t.type}:vencidas_qtd`, value: t.expired }])],
});
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma garantia: zero em todas as faixas', input: { rows: [] }, expected: okOf('0', '0', '0', []) },
  { kind: 'single', name: 'uma garantia vencendo em 30 dias', input: { rows: [row('GUARANTOR', 1, 1, 0)] }, expected: okOf('1', '1', '0', [typed('GUARANTOR', '1', '1', '0')]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 30 d: 4, 60 d: 7, vencidas: 1', input: { rows: [row('INSURANCE', 3, 5, 1), row('GUARANTOR', 1, 2, 0)] },
    expected: okOf('4', '7', '1', [typed('GUARANTOR', '1', '2', '0'), typed('INSURANCE', '3', '5', '1')]),
  },
  {
    kind: 'period_edge', name: 'garantia sem data de vencimento: INCOMPLETE e sem valor', input: { rows: [row('GUARANTOR', 2, 3, 0, 1), row('INSURANCE', 1, 1, 0, 2)] },
    expected: bad('INCOMPLETE', 'GARANTIA_SEM_VENCIMENTO', { withoutDate: '3' }),
  },
  {
    kind: 'rounding', name: 'contagens grandes somam exatas (sem ponto flutuante)', input: { rows: [row('GUARANTOR', '9007199254740993', '9007199254740994', 0), row('INSURANCE', 1, 1, 0)] },
    expected: okOf('9007199254740994', '9007199254740995', '0', [typed('GUARANTOR', '9007199254740993', '9007199254740994', '0'), typed('INSURANCE', '1', '1', '0')]),
  },
  { kind: 'period_edge', name: 'contagem de garantias sem data ainda não calculada pelo read model: DEGRADED e sem valor', input: { rows: [row('GUARANTOR', 1, 1, 0, null)] }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', {}) },
];

module.exports = { id: 'rent.guarantees_expiring', version: 1, compute, testCases };
