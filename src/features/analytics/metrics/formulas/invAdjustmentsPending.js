'use strict';

/**
 * M9-D709 — KPI inv.adjustments_pending (Propostas de ajuste de estoque pendentes), versão 1. Posição: contagem das propostas (InventoryAdjustmentProposal)
 * que esperam decisão no instante da leitura, com a soma do valor do ajuste em módulo (|quantidade| x custo médio, já calculado por proposta no read
 * model) em `valor_brl`, as envelhecidas e a contagem por depósito e por motivo. Entrada (rm_decision_queue, kind INV_ADJUSTMENT):
 * { asOfInstant, rows: [{ status, requested_at, decided_at, amount, item_id, quantity, warehouse_id, reason_code }] }. Qualidade: proposta sem item ou sem
 * quantidade -> INCOMPLETE, sem valor.
 */
const { computeQueue } = require('./_queueKpi');

const SPEC = {
  amount: true,
  incomplete: (row) => (row.item_id && row.quantity !== null && row.quantity !== undefined ? null : 'PROPOSTA_SEM_ITEM_OU_QUANTIDADE'),
  groups: [{ name: 'deposito', of: (r) => r.warehouse_id }, { name: 'motivo', of: (r) => r.reason_code }],
};

const compute = (input, params) => computeQueue(input, params, SPEC);

const NOW = '2026-10-28T15:00:00.000Z';
const P = { agedHours: 48 };
const row = (o) => ({ status: 'PENDING', requested_at: '2026-10-28T10:00:00.000Z', decided_at: null, amount: '0.00', item_id: 'i1', quantity: '1.0000', warehouse_id: 'w1', reason_code: 'ADJUSTMENT_OUT', ...o });
const ok = (count, aged, amount, extra = []) => ({
  value: count, status: 'OK', details: { count, aged, agedHours: '48', amount },
  dimensions: [{ key: 'envelhecidas_qtd', value: aged }, { key: 'valor_brl', value: amount }, ...extra],
});
const one = (n) => [{ key: 'deposito:w1', value: n }, { key: 'motivo:ADJUSTMENT_OUT', value: n }];

const testCases = [
  { kind: 'empty', name: 'fila vazia', input: { asOfInstant: NOW, rows: [] }, params: P, expected: ok('0', '0', '0.00') },
  { kind: 'single', name: 'uma proposta de 125,00 (10 un x 12,50)', input: { asOfInstant: NOW, rows: [row({ amount: '125.00', quantity: '10.0000' })] }, params: P, expected: ok('1', '0', '125.00', one('1')) },
  {
    kind: 'typical', name: 'exemplo do livro: 10 un x 12,50 e 4 un x 30,00 => 2 propostas e 245,00',
    input: { asOfInstant: NOW, rows: [row({ amount: '125.00', quantity: '10.0000' }), row({ amount: '120.00', quantity: '4.0000', warehouse_id: 'w2', reason_code: 'ADJUSTMENT_IN' })] }, params: P,
    expected: ok('2', '0', '245.00', [{ key: 'deposito:w1', value: '1' }, { key: 'deposito:w2', value: '1' }, { key: 'motivo:ADJUSTMENT_IN', value: '1' }, { key: 'motivo:ADJUSTMENT_OUT', value: '1' }]),
  },
  {
    kind: 'period_edge', name: 'borda: proposta decidida depois do instante ainda conta; a pedida depois não conta; a de 49 h é envelhecida',
    input: { asOfInstant: NOW, rows: [row({ status: 'DECIDED', decided_at: '2026-10-28T15:00:01.000Z', amount: '3.00' }), row({ requested_at: '2026-10-28T15:00:01.000Z', amount: '4.00' }), row({ requested_at: '2026-10-26T14:00:00.000Z', amount: '5.00' })] }, params: P,
    expected: ok('2', '1', '8.00', one('2')),
  },
  { kind: 'rounding', name: 'valores com centavos somam exato', input: { asOfInstant: NOW, rows: [row({ amount: '0.10' }), row({ amount: '0.20' })] }, params: P, expected: ok('2', '0', '0.30', one('2')) },
  {
    kind: 'typical', name: 'proposta sem item: INCOMPLETE e sem valor', input: { asOfInstant: NOW, rows: [row({ item_id: null })] }, params: P,
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PROPOSTA_SEM_ITEM_OU_QUANTIDADE', count: '1', aged: '0', agedHours: '48', amount: '0.00', incomplete: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'inv.adjustments_pending', version: 1, compute, testCases };
