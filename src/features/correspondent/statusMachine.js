'use strict';

const AppError = require('../../utils/AppError');

// Marco 8, máquina de estados completa — citação literal do Caderno (Guia do Marcelo):
// "DRAFT → DOCUMENTS_PENDING → READY_TO_SUBMIT → SUBMITTED → UNDER_ANALYSIS →
// PENDING_CUSTOMER/PENDING_PROPERTY → APPROVED/REJECTED → CONTRACTING → COMPLETED ou CANCELED."
//
// `RANK` modela essa ordem como um número: estágios "irmãos" (ex: UNDER_ANALYSIS,
// PENDING_CUSTOMER, PENDING_PROPERTY — todos "em andamento, aguardando algo") compartilham o
// mesmo rank; APPROVED e REJECTED também são irmãos (ambos terminam a fase de decisão); COMPLETED
// e CANCELED são os dois estados finais possíveis.
const RANK = {
  DRAFT: 0,
  DOCUMENTS_PENDING: 1,
  READY_TO_SUBMIT: 2,
  SUBMITTED: 3,
  UNDER_ANALYSIS: 4,
  PENDING_CUSTOMER: 4,
  PENDING_PROPERTY: 4,
  APPROVED: 5,
  REJECTED: 5,
  CONTRACTING: 6,
  COMPLETED: 7,
  CANCELED: 7,
};

// Pares de estados "irmãos" (mesmo rank) que são DECISÕES TERMINAIS mutuamente exclusivas — uma
// vez que o case chega num deles, um webhook atrasado/repetido com o irmão oposto NUNCA deve
// flipar o case (ex: um evento DENIED chegando fora de ordem depois de um APPROVED já aplicado
// não pode reverter a aprovação, e vice-versa). Movimentos laterais entre rank iguais só são
// permitidos quando NÃO fazem parte de um desses pares (ex: UNDER_ANALYSIS -> PENDING_CUSTOMER
// continua livre, ambos são "em andamento", não uma decisão final).
const EXCLUSIVE_TERMINAL_PAIRS = [
  ['APPROVED', 'REJECTED'],
  ['COMPLETED', 'CANCELED'],
];

function isExclusiveTerminalFlip(currentStatus, candidateStatus) {
  return EXCLUSIVE_TERMINAL_PAIRS.some(
    ([a, b]) => (currentStatus === a && candidateStatus === b) || (currentStatus === b && candidateStatus === a)
  );
}

/**
 * shouldApplyTransition — "Status fora de ordem não regride o case" (Caderno). Uma transição é
 * aplicada quando o novo status tem rank MAIOR OU IGUAL ao atual (rank igual cobre movimentos
 * laterais legítimos, ex: UNDER_ANALYSIS -> PENDING_CUSTOMER, ambos rank 4). Rank MENOR é
 * considerado "fora de ordem" (ex: um evento atrasado de UNDER_ANALYSIS chegando depois do case
 * já estar APPROVED) — a transição NUNCA é aplicada ao `financing_case.status`, mas o evento
 * ainda é sempre registrado no histórico (ver provider_status_history, `applied: false`).
 *
 * ACHADO REAL (auditoria pós-DoD, Frente Motor de Regras): rank igual sozinho também permitiria
 * um flip lateral entre decisões terminais opostas (ex: REJECTED -> APPROVED via webhook
 * atrasado/repetido com resultado diferente) — bloqueado explicitamente por
 * `isExclusiveTerminalFlip`, mesmo quando o rank bateria `>=`.
 *
 * Status não reconhecido pelo mapa (rank undefined) nunca é aplicado — fail closed: preferimos
 * não avançar a só ter certeza de não regredir por engano com um valor desconhecido.
 */
function shouldApplyTransition(currentStatus, candidateStatus) {
  const currentRank = RANK[currentStatus];
  const candidateRank = RANK[candidateStatus];
  if (candidateRank === undefined) return false;
  if (currentRank === undefined) return true; // estado atual não reconhecido — qualquer status válido pode assumir
  if (isExclusiveTerminalFlip(currentStatus, candidateStatus)) return false;
  return candidateRank >= currentRank;
}

/**
 * assertCaseNotCanceled — um caso cancelado não recebe documento, simulação, avaliação nem envio.
 */
function assertCaseNotCanceled(financingCase) {
  if (financingCase.status === 'CANCELED') {
    throw AppError.unprocessable('Este caso foi cancelado e não aceita novas ações.', 'FINANCING_CASE_CANCELED');
  }
}

module.exports = { assertCaseNotCanceled, RANK, shouldApplyTransition };
