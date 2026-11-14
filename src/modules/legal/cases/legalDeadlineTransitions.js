'use strict';

const { File } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { normalizeNote } = require('./legalDeadlineAccountability');
const { assertMayConclude } = require('./legalDeadlineResponsible');

/**
 * Transições do prazo (Caderno M5 §15 "Conclusão exige evidência/nota", §19 "Marcar prazo concluído | Responsável/
 * permissão + evidência"; cancelamento como fim alternativo, com motivo). Estados: PENDING -> DONE | CANCELLED;
 * DONE -> PENDING (reabrir); CANCELLED é terminal. Extraído de legalDeadlines.service.js (uma responsabilidade).
 *
 * DECISÃO (o livro não trata cancelamento): o mais conservador — motivo obrigatório, proibido com o processo em
 * legal hold (o hold trava o estado processual, legalCases.service.js) e, pela API, só com legal:approve.
 */
const TERMINAL = ['CANCELLED'];

function invalidTransition(from, to) {
  return AppError.conflict(`O prazo não pode ir de ${from} para ${to}.`, 'LEGAL_DEADLINE_INVALID_TRANSITION');
}

/** Cancelado não volta nem muda; só PENDING pode ser cancelado. */
function assertTransitionAllowed(currentStatus, finalStatus) {
  if (TERMINAL.includes(currentStatus)) throw invalidTransition(currentStatus, finalStatus);
  if (finalStatus === 'CANCELLED' && currentStatus !== 'PENDING') throw invalidTransition(currentStatus, finalStatus);
}

/** Motivo do cancelamento (changeReason ou, por compatibilidade com o BCP, conclusionNote). */
function assertCancellation({ deadline, legalCase, payload, actorUserId, permissions }) {
  const reason = normalizeNote(payload.changeReason) || normalizeNote(payload.conclusionNote);
  if (!reason) throw AppError.badRequest('Cancelar um prazo exige informar o motivo.', 'LEGAL_DEADLINE_CANCEL_REASON_REQUIRED');
  if (legalCase.legalHold) {
    throw AppError.conflict('Este processo está em legal hold (retenção legal): o prazo não pode ser cancelado.', 'LEGAL_CASE_ON_LEGAL_HOLD');
  }
  if (Array.isArray(permissions) && !permissions.includes('legal:approve')) {
    throw AppError.forbidden('Cancelar prazo jurídico exige a permissão de aprovação jurídica (legal:approve).', 'LEGAL_DEADLINE_CANCEL_NOT_ALLOWED');
  }
  return { cancelReason: reason, cancelledAt: new Date(), cancelledBy: actorUserId || null, deadlineId: deadline.id };
}

/**
 * Prova da conclusão: evidência (arquivo da empresa) ou nota com texto. Reavaliada quando o prazo está sendo concluído
 * agora ou quando, já concluído, a nota/evidência é alterada (prazo concluído não pode perder a prova).
 */
async function assertConclusionProof({ deadline, legalCase, payload, finalStatus, actorUserId, permissions, transaction }) {
  const noteProvided = payload.conclusionNote !== undefined;
  const newNote = noteProvided ? normalizeNote(payload.conclusionNote) : normalizeNote(deadline.conclusionNote);
  const concluding = finalStatus === 'DONE' && deadline.status !== 'DONE';
  const touchingProof = finalStatus === 'DONE' && (noteProvided || payload.conclusionEvidenceFileId !== undefined);
  // Pela API (o controller passa as permissões do token): só o responsável efetivo ou quem tem legal:approve (403).
  if (concluding && Array.isArray(permissions)) assertMayConclude({ actorUserId, permissions, deadline, legalCase });
  if (concluding || touchingProof) {
    const evidenceId = payload.conclusionEvidenceFileId !== undefined ? payload.conclusionEvidenceFileId : deadline.conclusionEvidenceFileId;
    if (!evidenceId && !newNote) {
      throw AppError.unprocessable('Concluir um prazo exige uma evidência anexada ou uma nota (com texto) explicando o que foi feito.', 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED');
    }
    if (evidenceId) {
      const file = await File.findOne({ where: { id: evidenceId, companyId: deadline.companyId }, transaction });
      if (!file) throw AppError.badRequest('O arquivo de evidência informado não existe ou não pertence a esta empresa.', 'LEGAL_DEADLINE_EVIDENCE_FILE_NOT_FOUND');
    }
  }
  return { noteProvided, newNote };
}

module.exports = { assertTransitionAllowed, assertCancellation, assertConclusionProof };
