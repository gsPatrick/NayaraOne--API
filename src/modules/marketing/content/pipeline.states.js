'use strict';

const { mktError } = require('../marketing.errors');

/**
 * M9-D406 — Máquina de estados do content_items.status: a ÚNICA tabela de transições permitidas (Caderno §4). Todo caminho que muda
 * o status chama assertTransition; qualquer par fora da tabela é 409 MKT_CONTENT_INVALID_TRANSITION.
 */
const BEFORE_PUBLISHING = Object.freeze([
  'DRAFT', 'FACT_CHECK_FAILED', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED',
]);

/** Transições do fluxo principal. Qualquer estado antes de PUBLISHING pode ir a ARCHIVED (acrescentado abaixo). */
const MAIN_TRANSITIONS = Object.freeze({
  DRAFT: ['FACT_CHECKED', 'FACT_CHECK_FAILED'],
  FACT_CHECK_FAILED: ['DRAFT'],
  FACT_CHECKED: ['BRANDED'],
  BRANDED: ['COMPLIANCE_CHECKED'],
  COMPLIANCE_CHECKED: ['PENDING_APPROVAL', 'APPROVED'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT'],
  APPROVED: ['SCHEDULED'],
  SCHEDULED: ['PUBLISHING'],
  PUBLISHING: ['PUBLISHED', 'FAILED'],
  FAILED: ['SCHEDULED'],
});

/**
 * As cinco transições que outras demandas exigem (M9-D404, M9-D405, M9-D410, M9-D411), cada uma com o seu executor.
 * `from: '*'` = qualquer estado anterior a PUBLISHING.
 */
const EXTRA_TRANSITIONS = Object.freeze([
  { id: 1, from: '*', to: 'FACT_CHECK_FAILED', executor: 'handler de property.updated (M9-D405)' },
  { id: 2, from: ['APPROVED', 'SCHEDULED'], to: 'PENDING_APPROVAL', executor: 'requestApprovalIfRequired / worker (M9-D404)' },
  { id: 3, from: ['PUBLISHED'], to: 'ARCHIVED', executor: 'serviço, item de atualização PUBLISHED (M9-D405)' },
  { id: 4, from: ['SCHEDULED'], to: 'PUBLISHING', executor: 'worker, primeiro job RUNNING (M9-D411)' },
  { id: 5, from: ['SCHEDULED'], to: 'APPROVED', executor: 'cancelamento humano de todos os jobs (M9-D410)' },
]);

function buildTable() {
  const table = new Map();
  const add = (from, to) => {
    if (from === to) return;
    if (!table.has(from)) table.set(from, new Set());
    table.get(from).add(to);
  };
  for (const [from, targets] of Object.entries(MAIN_TRANSITIONS)) targets.forEach((to) => add(from, to));
  for (const from of BEFORE_PUBLISHING) add(from, 'ARCHIVED');
  for (const extra of EXTRA_TRANSITIONS) {
    (extra.from === '*' ? BEFORE_PUBLISHING : extra.from).forEach((from) => add(from, extra.to));
  }
  return table;
}

const TABLE = buildTable();

function canTransition(from, to) {
  return TABLE.has(from) && TABLE.get(from).has(to);
}

function invalidTransition(from, to) {
  return mktError(409, 'MKT_CONTENT_INVALID_TRANSITION', `Transição de status inválida: ${from} -> ${to}.`, { from, to });
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw invalidTransition(from, to);
}

module.exports = { BEFORE_PUBLISHING, MAIN_TRANSITIONS, EXTRA_TRANSITIONS, canTransition, assertTransition, invalidTransition };
