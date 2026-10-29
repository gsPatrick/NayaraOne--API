'use strict';

/**
 * M9-D710 — KPI legal.contracts_signed (Contratos assinados na janela), versão 1. Contagem de contratos cujo estado passou a assinado dentro da janela móvel (analytics.centro.janela_horas,
 * padrão 24 h) e soma do valor do contrato em BRL (contrato sem valor não soma). Fluxo: original e compensatória (contrato revertido) somam zero. O valor é a contagem; o valor em reais, a
 * janela anterior de mesma duração e o detalhe por tipo de contrato vão em details e nas dimensões. Entrada (rm_command_events, kind CONTRACT_SIGNED): { rows: [{ type, count, amount }],
 * previous: { count, amount }, undated }. Regra de qualidade: contrato assinado sem data de assinatura -> INCOMPLETE, valor nulo.
 */
const { totalsOf, previousOf, groupBy, dimensionsOf, windowDimensions, undatedResult, hasUndated } = require('./_commandKpi');

function compute(input) {
  if (hasUndated(input)) return undatedResult('CONTRATO_ASSINADO_SEM_DATA', input.undated);
  const rows = input.rows || [];
  const total = totalsOf(rows);
  const previous = previousOf(input.previous);
  const byType = groupBy(rows, (r) => r.type || 'SEM_TIPO');
  return {
    value: total.count, status: 'OK',
    details: { count: total.count, amount: total.amount, previous, byType: byType.map((g) => ({ type: g.key, count: g.count, amount: g.amount })) },
    dimensions: [...windowDimensions(total, previous), ...dimensionsOf('tipo', byType)],
  };
}

const row = (type, count, amount) => ({ type, count, amount });
const okOf = (count, amount, previous, byType) => ({
  value: count, status: 'OK', details: { count, amount, previous, byType },
  dimensions: [{ key: 'valor_brl', value: amount }, { key: 'anterior_qtd', value: previous.count }, { key: 'anterior_valor_brl', value: previous.amount },
    ...byType.flatMap((t) => [{ key: `tipo:${t.type}:qtd`, value: t.count }, { key: `tipo:${t.type}:valor_brl`, value: t.amount }])],
});
const none = { count: '0', amount: '0.00' };
const incompleteOf = (undated) => ({ value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'CONTRATO_ASSINADO_SEM_DATA', undated }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhum contrato assinado na janela: zero e R$ 0,00', input: { rows: [], previous: none, undated: 0 }, expected: okOf('0', '0.00', none, []) },
  { kind: 'single', name: 'um contrato assinado', input: { rows: [row('LEASE', 1, '2400.00')], previous: none, undated: 0 }, expected: okOf('1', '2400.00', none, [{ type: 'LEASE', count: '1', amount: '2400.00' }]) },
  {
    kind: 'typical', name: 'exemplo da demanda: 2 contratos (480.000,00 e 2.400,00) = 2 e 482.400,00, com a janela anterior',
    input: { rows: [row('SALE', 1, '480000.00'), row('LEASE', 1, '2400.00')], previous: { count: 1, amount: '1000.00' }, undated: 0 },
    expected: okOf('2', '482400.00', { count: '1', amount: '1000.00' }, [{ type: 'LEASE', count: '1', amount: '2400.00' }, { type: 'SALE', count: '1', amount: '480000.00' }]),
  },
  {
    kind: 'period_edge', name: 'contrato revertido (original + compensatória) soma zero e contrato sem valor conta sem somar', input: { rows: [row('SALE', 0, '0.00'), row('SERVICE', 1, null)], previous: none, undated: 0 },
    expected: okOf('1', '0.00', none, [{ type: 'SALE', count: '0', amount: '0.00' }, { type: 'SERVICE', count: '1', amount: '0.00' }]),
  },
  {
    kind: 'rounding', name: 'valores com mais de duas casas arredondam uma só vez, meio para cima', input: { rows: [row('LEASE', 1, '0.004'), row('LEASE', 1, '0.004'), row('LEASE', 1, '0.002')], previous: none, undated: 0 },
    expected: okOf('3', '0.01', none, [{ type: 'LEASE', count: '3', amount: '0.01' }]),
  },
  { kind: 'period_edge', name: 'contrato assinado sem data de assinatura: INCOMPLETE e sem valor', input: { rows: [row('LEASE', 2, '10.00')], previous: none, undated: 1 }, expected: incompleteOf('1') },
];

module.exports = { id: 'legal.contracts_signed', version: 1, compute, testCases };
