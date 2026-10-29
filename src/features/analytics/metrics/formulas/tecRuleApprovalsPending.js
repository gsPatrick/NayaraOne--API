'use strict';

/**
 * M9-D709 — KPI tec.rule_approvals_pending (Aprovações de regra pendentes), versão 1. Posição: contagem dos pedidos de publicação de regra
 * (RuleApprovalRequest) que esperam aprovação no instante da leitura, as envelhecidas e a contagem por regra e solicitante. Sem valor monetário.
 * Entrada (rm_decision_queue, kind RULE_APPROVAL): { asOfInstant, rows: [{ status, requested_at, decided_at, rule_id, requested_by }] }.
 * Qualidade: pedido sem regra vinculada -> INCOMPLETE, sem valor.
 */
const { computeQueue } = require('./_queueKpi');

const SPEC = {
  amount: false,
  incomplete: (row) => (row.rule_id ? null : 'PEDIDO_SEM_REGRA_VINCULADA'),
  groups: [{ name: 'regra', of: (r) => r.rule_id }, { name: 'solicitante', of: (r) => r.requested_by }],
};

const compute = (input, params) => computeQueue(input, params, SPEC);

const NOW = '2026-10-28T15:00:00.000Z';
const P = { agedHours: 48 };
const row = (o) => ({ status: 'PENDING', requested_at: '2026-10-28T10:00:00.000Z', decided_at: null, rule_id: 'r1', requested_by: 'u1', ...o });
const ok = (count, aged, extra = []) => ({ value: count, status: 'OK', details: { count, aged, agedHours: '48' }, dimensions: [{ key: 'envelhecidas_qtd', value: aged }, ...extra] });

const testCases = [
  { kind: 'empty', name: 'fila vazia', input: { asOfInstant: NOW, rows: [] }, params: P, expected: ok('0', '0') },
  { kind: 'single', name: 'exemplo do livro: um pedido pendente => 1', input: { asOfInstant: NOW, rows: [row({})] }, params: P, expected: ok('1', '0', [{ key: 'regra:r1', value: '1' }, { key: 'solicitante:u1', value: '1' }]) },
  {
    kind: 'typical', name: 'dois pedidos de regras e solicitantes diferentes',
    input: { asOfInstant: NOW, rows: [row({}), row({ rule_id: 'r2', requested_by: 'u2' })] }, params: P,
    expected: ok('2', '0', [{ key: 'regra:r1', value: '1' }, { key: 'regra:r2', value: '1' }, { key: 'solicitante:u1', value: '1' }, { key: 'solicitante:u2', value: '1' }]),
  },
  {
    kind: 'period_edge', name: 'borda: decidido às 14:00 sai; decidido depois do instante ainda conta; 49 h é envelhecido',
    input: { asOfInstant: NOW, rows: [row({ status: 'DECIDED', decided_at: '2026-10-28T14:00:00.000Z' }), row({ status: 'DECIDED', decided_at: '2026-10-28T15:00:01.000Z' }), row({ requested_at: '2026-10-26T14:00:00.000Z' })] }, params: P,
    expected: ok('2', '1', [{ key: 'regra:r1', value: '2' }, { key: 'solicitante:u1', value: '2' }]),
  },
  { kind: 'rounding', name: 'limite de envelhecimento do administrador: 1 h torna envelhecido o pedido de 5 h', input: { asOfInstant: NOW, rows: [row({})] }, params: { agedHours: 1 }, expected: { ...ok('1', '1', [{ key: 'regra:r1', value: '1' }, { key: 'solicitante:u1', value: '1' }]), details: { count: '1', aged: '1', agedHours: '1' } } },
  {
    kind: 'typical', name: 'pedido sem regra vinculada: INCOMPLETE e sem valor', input: { asOfInstant: NOW, rows: [row({ rule_id: null })] }, params: P,
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PEDIDO_SEM_REGRA_VINCULADA', count: '1', aged: '0', agedHours: '48', incomplete: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'tec.rule_approvals_pending', version: 1, compute, testCases };
