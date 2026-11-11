'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize, Notice } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { normalizeOptionalText } = require('../../shared/legalText');
const { requireUuid, optionalUuid, assertFileInCompany, assertPersonInCompany } = require('../../shared/legalInput');

/**
 * Versões da notificação (Caderno M5 DoD "☐ Aditivos/notificações versionados"; §13 "Notificação possui canal,
 * destinatário, conteúdo/arquivo..." e "envio jurídico sensível requer revisão humana"). Cada versão do conteúdo fica
 * em legal.notice_versions (append-only no banco, migration 9998) com o SHA-256 do texto+arquivo. Corrigir o
 * conteúdo NUNCA sobrescreve a versão anterior: cria a próxima, devolve a notificação a DRAFT e exige nova revisão.
 * Depois de aprovada, enviada ou entregue, a notificação não muda mais (409): corrige-se com uma notificação nova.
 */
const EDITABLE = ['DRAFT', 'PENDING_REVIEW', 'REJECTED'];

const contentSha256 = (content, contentFileId) => crypto.createHash('sha256').update(`${content || ''}|${contentFileId || ''}`).digest('hex');

async function insertVersion(notice, reason, actorUserId, transaction) {
  const [row] = await sequelize.query(
    `INSERT INTO legal.notice_versions (group_id, company_id, notice_id, version_number, channel, recipient_person_id, recipient_description, content, content_file_id, content_sha256, drafted_by_ai, reason, created_by)
     VALUES (:groupId, :companyId, :noticeId, :version, :channel, :recipientPersonId, :recipientDescription, :content, :contentFileId, :sha, :draftedByAi, :reason, :createdBy)
     RETURNING id, version_number AS "versionNumber", content_sha256 AS "contentSha256", created_at AS "createdAt"`,
    {
      type: QueryTypes.SELECT,
      transaction,
      replacements: {
        groupId: notice.groupId, companyId: notice.companyId, noticeId: notice.id, version: notice.currentVersion, channel: notice.channel,
        recipientPersonId: notice.recipientPersonId || null, recipientDescription: notice.recipientDescription || null, content: notice.content || null,
        contentFileId: notice.contentFileId || null, sha: contentSha256(notice.content, notice.contentFileId), draftedByAi: Boolean(notice.draftedByAi),
        reason: reason || null, createdBy: actorUserId || null,
      },
    }
  );
  return row;
}

/** Versão 1, gravada na criação da notificação (mesma transação). */
const recordInitialVersion = (notice, actorUserId, transaction) => insertVersion(notice, 'Versão inicial.', actorUserId, transaction);

async function createNoticeVersion(noticeId, payload, actorUserId, transaction) {
  requireUuid(noticeId, 'id', 'LEGAL_NOTICE_VALIDATION');
  const notice = await Notice.findByPk(noticeId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!notice) throw AppError.notFound('Notificação não encontrada.', 'LEGAL_NOTICE_NOT_FOUND');
  if (!EDITABLE.includes(notice.status)) {
    throw AppError.conflict(`Notificação em "${notice.status}" não muda mais: para corrigir, emita uma nova notificação.`, 'LEGAL_NOTICE_VERSION_LOCKED');
  }
  const body = payload || {};
  const reason = normalizeOptionalText(body.reason, 'reason');
  if (!reason) throw AppError.badRequest('Informe o motivo da nova versão ("reason").', 'LEGAL_NOTICE_VALIDATION');
  if (body.contentFileId !== undefined) optionalUuid(body.contentFileId, 'contentFileId', 'LEGAL_NOTICE_VALIDATION');
  const next = {
    content: body.content !== undefined ? normalizeOptionalText(body.content, 'content') : notice.content,
    contentFileId: body.contentFileId !== undefined ? await assertFileInCompany(body.contentFileId, notice.companyId, 'contentFileId', 'LEGAL_NOTICE_FILE_NOT_FOUND', transaction) : notice.contentFileId,
    recipientDescription: body.recipientDescription !== undefined ? normalizeOptionalText(body.recipientDescription, 'recipientDescription') : notice.recipientDescription,
    recipientPersonId: body.recipientPersonId !== undefined ? await assertPersonInCompany(body.recipientPersonId, notice.companyId, 'recipientPersonId', 'LEGAL_NOTICE_VALIDATION', transaction) : notice.recipientPersonId,
  };
  if (!next.content && !next.contentFileId) throw AppError.badRequest('Informe "content" (texto) e/ou "contentFileId" (arquivo).', 'LEGAL_NOTICE_VALIDATION');
  if (contentSha256(next.content, next.contentFileId) === contentSha256(notice.content, notice.contentFileId)
    && next.recipientDescription === notice.recipientDescription && next.recipientPersonId === notice.recipientPersonId) {
    throw AppError.conflict('A nova versão é idêntica à atual.', 'LEGAL_NOTICE_VERSION_UNCHANGED');
  }
  const beforeJson = notice.toJSON();
  Object.assign(notice, next, {
    currentVersion: notice.currentVersion + 1, approvedVersion: null, status: 'DRAFT', reviewedByUserId: null, reviewedAt: null, updatedBy: actorUserId || null,
  });
  await notice.save({ transaction });
  const version = await insertVersion(notice, reason, actorUserId, transaction);
  await registrarAuditoria(
    { groupId: notice.groupId, companyId: notice.companyId, actorUserId, action: 'legal.notice.new_version', entityType: 'Notice', entityId: notice.id, beforeJson, afterJson: notice.toJSON(), reason: `Nova versão ${notice.currentVersion} da notificação: ${reason}` },
    transaction
  );
  return { notice, version };
}

async function listNoticeVersions(noticeId, transaction) {
  const notice = await Notice.findByPk(noticeId, { transaction });
  if (!notice) throw AppError.notFound('Notificação não encontrada.', 'LEGAL_NOTICE_NOT_FOUND');
  return sequelize.query(
    `SELECT id, notice_id AS "noticeId", version_number AS "versionNumber", channel, recipient_person_id AS "recipientPersonId", recipient_description AS "recipientDescription",
            content, content_file_id AS "contentFileId", content_sha256 AS "contentSha256", drafted_by_ai AS "draftedByAi", reason, created_by AS "createdBy", created_at AS "createdAt"
       FROM legal.notice_versions WHERE notice_id = :id ORDER BY version_number`,
    { type: QueryTypes.SELECT, transaction, replacements: { id: notice.id } }
  );
}

module.exports = { recordInitialVersion, createNoticeVersion, listNoticeVersions, contentSha256 };
