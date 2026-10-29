'use strict';

/**
 * Máquina de estados do envio (M9-D205 3.2): ÚNICA fonte de verdade, espelhada no teste.
 * Regras que dependem de quem pede (ficam em assertDispatchTransition):
 *  - FAILED e DEAD_LETTER -> RETRY_WAIT só pelo retry humano autorizado (D250); FAILED por AUTH volta sozinho quando a connection
 *    é reativada por test-connection verde (authRecovery, M9-D216);
 *  - UNKNOWN -> RETRY_WAIT em operação DANGEROUS só depois da reconciliação (D215).
 */
const TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['SENDING', 'CANCELLED']),
  SENDING: Object.freeze(['SUBMITTED', 'CONFIRMED', 'RETRY_WAIT', 'UNKNOWN', 'FAILED']),
  SUBMITTED: Object.freeze(['CONFIRMED', 'UNKNOWN', 'FAILED']),
  RETRY_WAIT: Object.freeze(['SENDING', 'DEAD_LETTER', 'CANCELLED']),
  UNKNOWN: Object.freeze(['SUBMITTED', 'CONFIRMED', 'FAILED', 'RETRY_WAIT', 'DEAD_LETTER']),
  FAILED: Object.freeze(['RETRY_WAIT', 'DEAD_LETTER']),
  DEAD_LETTER: Object.freeze(['RETRY_WAIT']),
  CONFIRMED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

/** Devolve o motivo da recusa (texto) ou null se a transição vale. */
function refusalReason(from, to, { criticalityOp, humanRetry, reconciled, authRecovery } = {}) {
  if (!(TRANSITIONS[from] || []).includes(to)) return 'fora da tabela de transições';
  if (from === 'FAILED' && to === 'RETRY_WAIT' && authRecovery) return null; // connection voltou por test-connection verde (M9-D216 3.2)
  if ((from === 'FAILED' || from === 'DEAD_LETTER') && to === 'RETRY_WAIT' && !humanRetry) return 'só o retry humano autorizado reabre este envio';
  if (from === 'UNKNOWN' && to === 'RETRY_WAIT' && criticalityOp !== 'SAFE' && !reconciled) return 'operação perigosa em estado desconhecido só tenta de novo depois da reconciliação';
  return null;
}

module.exports = { TRANSITIONS, refusalReason };
