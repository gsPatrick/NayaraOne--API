'use strict';

const { Notice, Contract, LegalCase } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../engines/events/outbox');

/**
 * notices.service.js — auditoria externa (contrato bruto, Anexo I "4. Entidades/tabelas
 * obrigatórias" + "13. Aditivos e notificações"): "legal.notices: Notificações." /
 * "Notificação possui canal, destinatário, conteúdo/arquivo, data e evidência de
 * envio/recebimento quando disponível." / "IA pode rascunhar; envio jurídico sensível requer
 * revisão humana."
 *
 * Máquina de estados da notificação (espelha a exigência de revisão humana para envio
 * jurídico sensível — JUR-008 "IA não decide direito"):
 *   DRAFT -> PENDING_REVIEW -> APPROVED -> SENT -> DELIVERED
 *                            \-> REJECTED
 * Uma notificação NÃO sensível pode ir direto de DRAFT para APPROVED (sem review obrigatória);
 * uma SENSÍVEL (isLegallySensitive=true OU draftedByAi=true) é OBRIGADA a passar por
 * PENDING_REVIEW -> APPROVED por um humano antes de SENT — nunca enviada direto.
 *
 * NOTA DE AMBIENTE (07/10/2026): depende da tabela "legal"."notices" (migration 20260101000292),
 * AINDA NÃO aplicada neste banco (sem credencial de DDL disponível — ver nota em
 * src/models/Notice.js). Código pronto para uso assim que a migration rodar em um ambiente com
 * `nayara_migration`.
 */
const CHANNELS = ['EMAIL', 'WHATSAPP', 'POSTAL_MAIL', 'IN_PERSON', 'OTHER'];
const STATUSES = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'SENT', 'DELIVERED', 'REJECTED'];

async function assertOwner(contractId, legalCaseId, transaction) {
  if (!contractId && !legalCaseId) {
    throw AppError.badRequest('Informe "contractId" OU "legalCaseId" (a notificação precisa estar vinculada a um dos dois).', 'LEGAL_NOTICE_VALIDATION');
  }
  if (contractId && legalCaseId) {
    throw AppError.badRequest('Informe apenas UM vínculo: "contractId" OU "legalCaseId", nunca os dois.', 'LEGAL_NOTICE_VALIDATION');
  }
  if (contractId) {
    const contract = await Contract.findByPk(contractId, { transaction });
    if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
    return { groupId: contract.groupId, companyId: contract.companyId };
  }
  const legalCase = await LegalCase.findByPk(legalCaseId, { transaction });
  if (!legalCase) throw AppError.notFound('Processo jurídico não encontrado.', 'LEGAL_CASE_NOT_FOUND');
  return { groupId: legalCase.groupId, companyId: legalCase.companyId };
}

async function createNotice(payload, actorUserId, transaction) {
  const {
    contractId,
    legalCaseId,
    channel,
    recipientPersonId,
    recipientDescription,
    content,
    contentFileId,
    isLegallySensitive,
    draftedByAi,
  } = payload;

  if (!channel || !CHANNELS.includes(channel)) {
    throw AppError.badRequest(`"channel" deve ser um de: ${CHANNELS.join(', ')}.`, 'LEGAL_NOTICE_VALIDATION');
  }
  if (!content && !contentFileId) {
    throw AppError.badRequest('Informe "content" (texto) e/ou "contentFileId" (arquivo).', 'LEGAL_NOTICE_VALIDATION');
  }

  const { groupId, companyId } = await assertOwner(contractId, legalCaseId, transaction);

  const notice = await Notice.create(
    {
      groupId,
      companyId,
      contractId: contractId || null,
      legalCaseId: legalCaseId || null,
      channel,
      recipientPersonId: recipientPersonId || null,
      recipientDescription: recipientDescription || null,
      content: content || null,
      contentFileId: contentFileId || null,
      isLegallySensitive: Boolean(isLegallySensitive),
      draftedByAi: Boolean(draftedByAi),
      status: 'DRAFT',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.notice.create',
      entityType: 'Notice',
      entityId: notice.id,
      afterJson: notice.toJSON(),
      reason: `Notificação criada (canal "${channel}") em DRAFT.`,
    },
    transaction
  );

  return notice;
}

async function listNotices(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.legalCaseId) where.legalCaseId = filters.legalCaseId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Notice.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getNotice(id, transaction) {
  const notice = await Notice.findByPk(id, { transaction });
  if (!notice) throw AppError.notFound('Notificação não encontrada.', 'LEGAL_NOTICE_NOT_FOUND');
  return notice;
}

/**
 * isSensitive — critério de "envio jurídico sensível requer revisão humana": marcado
 * explicitamente OU rascunhado pela IA (NAY) — JUR-008 "IA não decide direito", decisão
 * jurídica é sempre humana.
 */
function isSensitive(notice) {
  return Boolean(notice.isLegallySensitive) || Boolean(notice.draftedByAi);
}

/**
 * submitForReview — DRAFT -> PENDING_REVIEW. Só faz sentido para notificações sensíveis (as
 * não sensíveis podem ir direto para approveNotice).
 */
async function submitNoticeForReview(id, actorUserId, transaction) {
  const notice = await getNotice(id, transaction);
  if (notice.status !== 'DRAFT') {
    throw AppError.conflict(`Só é possível submeter à revisão uma notificação em DRAFT (atual: "${notice.status}").`, 'LEGAL_NOTICE_INVALID_TRANSITION');
  }
  const beforeJson = notice.toJSON();
  notice.status = 'PENDING_REVIEW';
  notice.updatedBy = actorUserId || null;
  await notice.save({ transaction });

  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.submit_for_review', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: 'Notificação submetida à revisão humana.' },
    transaction
  );
  return notice;
}

/**
 * approveNotice — PENDING_REVIEW -> APPROVED (sensível, exige revisão humana prévia) ou DRAFT
 * -> APPROVED (não sensível, sem review obrigatória). Fail closed: notificação sensível NUNCA
 * pula PENDING_REVIEW.
 */
async function approveNotice(id, actorUserId, transaction) {
  const notice = await getNotice(id, transaction);
  const sensitive = isSensitive(notice);

  if (sensitive && notice.status !== 'PENDING_REVIEW') {
    throw AppError.conflict(
      'Notificação jurídica sensível (marcada como sensível e/ou rascunhada por IA) precisa passar por "PENDING_REVIEW" antes de ser aprovada — não pode ser aprovada direto de DRAFT.',
      'LEGAL_NOTICE_REVIEW_REQUIRED'
    );
  }
  if (!sensitive && !['DRAFT', 'PENDING_REVIEW'].includes(notice.status)) {
    throw AppError.conflict(`Transição inválida para "APPROVED" a partir de "${notice.status}".`, 'LEGAL_NOTICE_INVALID_TRANSITION');
  }

  const beforeJson = notice.toJSON();
  notice.status = 'APPROVED';
  notice.reviewedByUserId = actorUserId || null;
  notice.reviewedAt = new Date();
  notice.updatedBy = actorUserId || null;
  await notice.save({ transaction });

  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.approve', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: 'Notificação aprovada por revisão humana.' },
    transaction
  );
  return notice;
}

async function rejectNotice(id, reason, actorUserId, transaction) {
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('O campo "reason" é obrigatório para rejeitar uma notificação.', 'LEGAL_NOTICE_VALIDATION');
  }
  const notice = await getNotice(id, transaction);
  if (!['DRAFT', 'PENDING_REVIEW'].includes(notice.status)) {
    throw AppError.conflict(`Só é possível rejeitar notificações em DRAFT/PENDING_REVIEW (atual: "${notice.status}").`, 'LEGAL_NOTICE_INVALID_TRANSITION');
  }
  const beforeJson = notice.toJSON();
  notice.status = 'REJECTED';
  notice.reviewedByUserId = actorUserId || null;
  notice.reviewedAt = new Date();
  notice.updatedBy = actorUserId || null;
  await notice.save({ transaction });

  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.reject', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: `Notificação rejeitada: ${reason}` },
    transaction
  );
  return notice;
}

/**
 * sendNotice — APPROVED -> SENT. Fail closed (JUR-015): nunca envia direto de DRAFT/
 * PENDING_REVIEW, mesmo que o chamador tente pular etapas — "envio jurídico sensível requer
 * revisão humana" é reconferido aqui de novo (não confiamos só no histórico).
 */
async function sendNotice(id, actorUserId, transaction) {
  const notice = await getNotice(id, transaction);
  if (notice.status !== 'APPROVED') {
    throw AppError.conflict(
      `Não é possível enviar: notificação precisa estar "APPROVED" (atual: "${notice.status}"). Notificações sensíveis exigem revisão humana (PENDING_REVIEW -> APPROVED) antes do envio.`,
      'LEGAL_NOTICE_SEND_BLOCKED'
    );
  }

  const beforeJson = notice.toJSON();
  notice.status = 'SENT';
  notice.sentAt = new Date();
  notice.sentByUserId = actorUserId || null;
  notice.updatedBy = actorUserId || null;
  await notice.save({ transaction });

  await publishDomainEvent(
    {
      groupId: notice.groupId,
      companyId: notice.companyId,
      aggregateType: 'Notice',
      aggregateId: notice.id,
      eventType: 'legal.notice.sent',
      payload: { id: notice.id, contractId: notice.contractId, legalCaseId: notice.legalCaseId, channel: notice.channel },
      idempotencyKey: `legal.notice.sent:${notice.id}`,
    },
    transaction
  );

  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.send', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: 'Notificação enviada.' },
    transaction
  );
  return notice;
}

/**
 * registerDeliveryEvidence — "evidência de envio/recebimento quando disponível." Registra a
 * evidência (ex.: comprovante de entrega, AR, print de confirmação) sem exigir nenhum avanço
 * de status adicional além de SENT -> DELIVERED quando a evidência prova a entrega.
 */
async function registerDeliveryEvidence(id, payload, actorUserId, transaction) {
  const notice = await getNotice(id, transaction);
  if (!['SENT', 'DELIVERED'].includes(notice.status)) {
    throw AppError.conflict(`Só é possível registrar evidência de entrega após o envio (atual: "${notice.status}").`, 'LEGAL_NOTICE_INVALID_TRANSITION');
  }
  const { deliveryEvidenceFileId, deliveredAt } = payload || {};
  if (!deliveryEvidenceFileId) {
    throw AppError.badRequest('"deliveryEvidenceFileId" é obrigatório.', 'LEGAL_NOTICE_VALIDATION');
  }
  const beforeJson = notice.toJSON();
  notice.deliveryEvidenceFileId = deliveryEvidenceFileId;
  notice.deliveredAt = deliveredAt ? new Date(deliveredAt) : new Date();
  notice.status = 'DELIVERED';
  notice.updatedBy = actorUserId || null;
  await notice.save({ transaction });

  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.register_delivery_evidence', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: 'Evidência de entrega registrada.' },
    transaction
  );
  return notice;
}

module.exports = {
  createNotice,
  listNotices,
  getNotice,
  submitNoticeForReview,
  approveNotice,
  rejectNotice,
  sendNotice,
  registerDeliveryEvidence,
  isSensitive,
  CHANNELS,
  STATUSES,
};
