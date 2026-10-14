'use strict';

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

/**
 * shouldApplyTransition — "Status fora de ordem não regride o case" (Caderno). Uma transição é
 * aplicada quando o novo status tem rank MAIOR OU IGUAL ao atual (rank igual cobre movimentos
 * laterais legítimos, ex: UNDER_ANALYSIS -> PENDING_CUSTOMER, ambos rank 4). Rank MENOR é
 * considerado "fora de ordem" (ex: um evento atrasado de UNDER_ANALYSIS chegando depois do case
 * já estar APPROVED) — a transição NUNCA é aplicada ao `financing_case.status`, mas o evento
 * ainda é sempre registrado no histórico (ver provider_status_history, `applied: false`).
 *
 * Status não reconhecido pelo mapa (rank undefined) nunca é aplicado — fail closed: preferimos
 * não avançar a só ter certeza de não regredir por engano com um valor desconhecido.
 */
function shouldApplyTransition(currentStatus, candidateStatus) {
  const currentRank = RANK[currentStatus];
  const candidateRank = RANK[candidateStatus];
  if (candidateRank === undefined) return false;
  if (currentRank === undefined) return true; // estado atual não reconhecido — qualquer status válido pode assumir
  return candidateRank >= currentRank;
}

module.exports = { RANK, shouldApplyTransition };
