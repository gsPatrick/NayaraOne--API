'use strict';

/**
 * M9-D709 — KPI ai.proposals_pending (Propostas da NAY aguardando aprovação humana), versão 1. Posição: contagem das propostas com ação proposta
 * (ai.ai_recommendations com proposed_action) que esperam decisão no instante da leitura, por agente e tipo de proposta, com as envelhecidas. Recomendação
 * informativa (sem proposed_action) nunca chega aqui. Sem valor monetário. Entrada (rm_decision_queue, kind NAY_PROPOSAL):
 * { asOfInstant, rows: [{ status, requested_at, decided_at, agent_code, proposal_type, run_id, has_sources }] }. Qualidade: proposta sem execução (run_id)
 * ou sem fontes -> INCOMPLETE, sem valor.
 */
const { computeQueue } = require('./_queueKpi');

const SPEC = {
  amount: false,
  incomplete: (row) => (row.run_id && row.has_sources === true ? null : 'PROPOSTA_SEM_EXECUCAO_OU_FONTES'),
  groups: [{ name: 'agente', of: (r) => r.agent_code }, { name: 'tipo', of: (r) => r.proposal_type }],
};

const compute = (input, params) => computeQueue(input, params, SPEC);

const NOW = '2026-10-28T15:00:00.000Z';
const P = { agedHours: 48 };
const row = (o) => ({ status: 'PENDING', requested_at: '2026-10-28T10:00:00.000Z', decided_at: null, agent_code: 'NAY_FINANCEIRA', proposal_type: 'payment', run_id: 'run1', has_sources: true, ...o });
const ok = (count, aged, extra = []) => ({ value: count, status: 'OK', details: { count, aged, agedHours: '48' }, dimensions: [{ key: 'envelhecidas_qtd', value: aged }, ...extra] });
const many = (n, o) => Array.from({ length: n }, () => row(o));

const testCases = [
  { kind: 'empty', name: 'fila vazia', input: { asOfInstant: NOW, rows: [] }, params: P, expected: ok('0', '0') },
  { kind: 'single', name: 'uma proposta', input: { asOfInstant: NOW, rows: [row({})] }, params: P, expected: ok('1', '0', [{ key: 'agente:NAY_FINANCEIRA', value: '1' }, { key: 'tipo:payment', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: 3 da NAY Financeira e 2 da NAY Comercial => 5',
    input: { asOfInstant: NOW, rows: [...many(3, {}), ...many(2, { agent_code: 'NAY_COMERCIAL', proposal_type: 'followup' })] }, params: P,
    expected: ok('5', '0', [{ key: 'agente:NAY_COMERCIAL', value: '2' }, { key: 'agente:NAY_FINANCEIRA', value: '3' }, { key: 'tipo:followup', value: '2' }, { key: 'tipo:payment', value: '3' }]),
  },
  {
    kind: 'period_edge', name: 'borda: aceita depois do instante ainda conta; rejeitada antes sai; 80 h é envelhecida',
    input: { asOfInstant: NOW, rows: [row({ status: 'DECIDED', decided_at: '2026-10-28T15:00:01.000Z' }), row({ status: 'DECIDED', decided_at: '2026-10-28T12:00:00.000Z' }), row({ requested_at: '2026-10-25T07:00:00.000Z' })] }, params: P,
    expected: ok('2', '1', [{ key: 'agente:NAY_FINANCEIRA', value: '2' }, { key: 'tipo:payment', value: '2' }]),
  },
  { kind: 'rounding', name: 'tipo sem informação entra como NAO_INFORMADO', input: { asOfInstant: NOW, rows: [row({ proposal_type: null })] }, params: P, expected: ok('1', '0', [{ key: 'agente:NAY_FINANCEIRA', value: '1' }, { key: 'tipo:NAO_INFORMADO', value: '1' }]) },
  {
    kind: 'typical', name: 'exemplo do livro: proposta sem run_id => INCOMPLETE e sem valor', input: { asOfInstant: NOW, rows: [row({}), row({ run_id: null })] }, params: P,
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PROPOSTA_SEM_EXECUCAO_OU_FONTES', count: '2', aged: '0', agedHours: '48', incomplete: '1' }, dimensions: [] },
  },
  {
    kind: 'typical', name: 'proposta sem fontes => INCOMPLETE e sem valor', input: { asOfInstant: NOW, rows: [row({ has_sources: false })] }, params: P,
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'PROPOSTA_SEM_EXECUCAO_OU_FONTES', count: '1', aged: '0', agedHours: '48', incomplete: '1' }, dimensions: [] },
  },
];

module.exports = { id: 'ai.proposals_pending', version: 1, compute, testCases };
