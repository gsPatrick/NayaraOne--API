'use strict';

/**
 * Máquina de estados do contrato (Guia do Marco 5, §3), camada de domínio (Guia §2 contracts/domain/).
 */
const AppError = require('../../../../utils/AppError');

// Matriz M5: a tabela é EXATAMENTE a do Guia §3 (CANCELLED não é estado do livro: contratos antigos gravados
// como CANCELLED continuam legíveis e terminais — nenhuma transição parte deles nem chega a eles).
const VALID_TRANSITIONS = {
  DRAFT: ['DOCUMENTS_PENDING', 'LEGAL_REVIEW'],
  DOCUMENTS_PENDING: ['LEGAL_REVIEW'],
  LEGAL_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['SIGNING'],
  SIGNING: ['SIGNED', 'APPROVED'],
  SIGNED: ['ACTIVE'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

/** Guia §3: assertTransition(from, to) — recusa a transição que não está na tabela. */
function assertTransition(from, to) {
  if (!(VALID_TRANSITIONS[from] || []).includes(to)) {
    throw AppError.conflict(`Transição de ${from} para ${to} não é permitida.`, 'LEGAL_CONTRACT_INVALID_TRANSITION');
  }
}

module.exports = { VALID_TRANSITIONS, assertTransition };
