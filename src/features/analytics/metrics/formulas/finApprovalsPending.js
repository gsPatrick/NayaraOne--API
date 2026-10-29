'use strict';

/**
 * M9-D709 — KPI fin.approvals_pending (Aprovações financeiras pendentes), versão 1. Posição: contagem das aprovações do Financeiro (ApprovalRequest) que
 * esperam decisão no instante da leitura, com a soma do valor envolvido (BRL, só das que têm valor) em `valor_brl`, as envelhecidas (idade em horas acima
 * de analytics.centro.decisao_atraso_horas) e a contagem por tipo, solicitante e alçada. Entrada (rm_decision_queue, kind FIN_APPROVAL):
 * { asOfInstant, rows: [{ status, requested_at, decided_at, amount, approval_type, requested_by, approval_tier }] }. Qualidade: aprovação aberta sem data
 * do pedido -> INCOMPLETE, sem valor.
 */
const { computeQueue } = require('./_queueKpi');

const SPEC = {
  amount: true,
  incomplete: (row) => (row.requested_at ? null : 'APROVACAO_SEM_DATA_DO_PEDIDO'),
  groups: [{ name: 'tipo', of: (r) => r.approval_type }, { name: 'solicitante', of: (r) => r.requested_by }, { name: 'alcada', of: (r) => r.approval_tier }],
};

const compute = (input, params) => computeQueue(input, params, SPEC);

const NOW = '2026-10-28T15:00:00.000Z';
const P = { agedHours: 48 };
const row = (o) => ({ status: 'PENDING', requested_at: '2026-10-28T10:00:00.000Z', decided_at: null, amount: null, approval_type: 'FinancialEntry', requested_by: 'u1', approval_tier: 'MEDIUM', ...o });
const ok = (count, aged, amount, extra = []) => ({
  value: count, status: 'OK', details: { count, aged, agedHours: '48', amount },
  dimensions: [{ key: 'envelhecidas_qtd', value: aged }, { key: 'valor_brl', value: amount }, ...extra],
});

const testCases = [
  { kind: 'empty', name: 'fila vazia: zero aprovações e R$ 0,00', input: { asOfInstant: NOW, rows: [] }, params: P, expected: ok('0', '0', '0.00') },
  {
    kind: 'single', name: 'uma aprovação de 1.500,00', input: { asOfInstant: NOW, rows: [row({ amount: '1500.00' })] }, params: P,
    expected: ok('1', '0', '1500.00', [{ key: 'tipo:FinancialEntry', value: '1' }, { key: 'solicitante:u1', value: '1' }, { key: 'alcada:MEDIUM', value: '1' }]),
  },
  {
    kind: 'typical', name: 'exemplo do livro: 12.000,00 + 8.500,00 + uma sem valor => 3 e 20.500,00',
    input: { asOfInstant: NOW, rows: [row({ amount: '12000.00' }), row({ amount: '8500.00', approval_type: 'Commission', requested_by: 'u2', approval_tier: 'HIGH' }), row({ approval_type: 'Commission', requested_by: 'u2', approval_tier: 'HIGH' })] }, params: P,
    expected: ok('3', '0', '20500.00', [{ key: 'tipo:Commission', value: '2' }, { key: 'tipo:FinancialEntry', value: '1' }, { key: 'solicitante:u1', value: '1' }, { key: 'solicitante:u2', value: '2' }, { key: 'alcada:HIGH', value: '2' }, { key: 'alcada:MEDIUM', value: '1' }]),
  },
  {
    kind: 'period_edge', name: 'borda: 48 h exatas não é envelhecida, 49 h é; decidida depois do instante ainda conta, decidida antes e pedida depois não contam',
    input: {
      asOfInstant: NOW,
      rows: [
        row({ requested_at: '2026-10-26T15:00:00.000Z', amount: '10.00' }), row({ requested_at: '2026-10-26T14:00:00.000Z', amount: '20.00' }),
        row({ status: 'DECIDED', decided_at: '2026-10-28T16:00:00.000Z', amount: '5.00' }), row({ status: 'DECIDED', decided_at: '2026-10-28T14:00:00.000Z', amount: '7.00' }),
        row({ requested_at: '2026-10-28T15:00:01.000Z', amount: '9.00' }),
      ],
    },
    params: P, expected: ok('3', '1', '35.00', [{ key: 'tipo:FinancialEntry', value: '3' }, { key: 'solicitante:u1', value: '3' }, { key: 'alcada:MEDIUM', value: '3' }]),
  },
  {
    kind: 'rounding', name: 'valores com centavos somam exato: 0,10 + 0,20 = 0,30', input: { asOfInstant: NOW, rows: [row({ amount: '0.10' }), row({ amount: '0.20' })] }, params: P,
    expected: ok('2', '0', '0.30', [{ key: 'tipo:FinancialEntry', value: '2' }, { key: 'solicitante:u1', value: '2' }, { key: 'alcada:MEDIUM', value: '2' }]),
  },
  {
    kind: 'typical', name: 'aprovação aberta sem data do pedido: INCOMPLETE e sem valor', input: { asOfInstant: NOW, rows: [row({ amount: '10.00' }), row({ requested_at: null })] }, params: P,
    expected: {
      value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.',
      details: { reason: 'APROVACAO_SEM_DATA_DO_PEDIDO', count: '2', aged: '0', agedHours: '48', amount: '10.00', incomplete: '1' }, dimensions: [],
    },
  },
];

module.exports = { id: 'fin.approvals_pending', version: 1, compute, testCases };
