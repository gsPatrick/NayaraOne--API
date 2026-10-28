'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('./approval.repository');
const { computeApprovedHash } = require('./template.hash');
const { contentNotFound, approvalInvalidated } = require('./template.errors');

const GUARDED_STATUSES = Object.freeze(['APPROVED', 'SCHEDULED']);

async function hashFor(version, transaction) {
  const template = version.template_id ? await repo.findTemplate(version.template_id, transaction) : null;
  return computeApprovedHash({
    contentHash: version.content_hash,
    templateId: template ? template.id : null,
    templateVersionNo: template ? template.version_no : null,
    templateContentHash: template ? template.content_hash : null,
  });
}

/**
 * Chamado por quem aprova (M9-D408): grava em content_versions.approved_hash o SHA-256 de content_hash + template_id +
 * template.version_no + template.content_hash. A versão do conteúdo é imutável; só os campos de aprovação mudam.
 */
async function recordApprovedHash(tenant, actorUserId, contentVersionId, transaction) {
  const version = await repo.lockVersion(contentVersionId, transaction);
  if (!version) throw contentNotFound();
  const approvedHash = await hashFor(version, transaction);
  await repo.setApprovedHash(version.id, approvedHash, actorUserId || null, transaction);
  return { contentVersionId: version.id, approvedHash };
}

/**
 * Confere se a aprovação do item continua valendo (Caderno §14 e §16: "Template alterado após approval invalida aprovação").
 * Chamado antes de agendar (M9-D410) e de novo no worker de publicação (M9-D411). Recalcula o hash da versão corrente; se
 * diferente do approved_hash (template ou conteúdo mudou, ou a versão corrente nunca foi aprovada), invalida: o item volta a
 * PENDING_APPROVAL, a aprovação é limpa, os jobs PENDING são cancelados (APPROVAL_INVALIDATED) e a auditoria é gravada.
 * NÃO lança: o chamador precisa confirmar (commit) a invalidação antes de responder o erro; use approvalInvalidatedError(resultado)
 * depois do commit (a transação com throw desfaria a própria invalidação).
 */
async function checkApproval(tenant, actorUserId, contentItemId, transaction, { origin = 'SCHEDULE' } = {}) {
  const item = await repo.lockItem(contentItemId, transaction);
  if (!item) throw contentNotFound();
  if (!GUARDED_STATUSES.includes(item.status)) return { intact: true, invalidated: false, skipped: true, cancelledJobs: 0, itemId: item.id };

  const version = item.current_version_id ? await repo.findVersion(item.current_version_id, transaction) : null;
  const expected = version ? await hashFor(version, transaction) : null;
  if (version && version.approved_hash && version.approved_hash === expected) {
    return { intact: true, invalidated: false, skipped: false, cancelledJobs: 0, itemId: item.id };
  }

  await repo.clearApprovals(item.id, actorUserId || null, transaction);
  await repo.setItemPendingApproval(item.id, actorUserId || null, transaction);
  const cancelled = await repo.cancelPendingJobs(item.id, actorUserId || null, transaction);
  const reason = version && version.approved_hash ? 'O template ou o conteúdo mudou desde a aprovação.' : 'A versão corrente do conteúdo não tem aprovação.';
  await registrarAuditoria({
    groupId: tenant.groupId,
    companyId: tenant.companyId,
    actorUserId,
    action: 'marketing.approval.invalidated',
    entityType: 'marketing.content_item',
    entityId: item.id,
    beforeJson: { status: item.status, currentVersionId: item.current_version_id, approvedHash: version ? version.approved_hash : null },
    afterJson: { status: 'PENDING_APPROVAL', expectedHash: expected, cancelledJobs: cancelled.length, cancelledJobIds: cancelled, origin },
    reason: `APPROVAL_INVALIDATED (${origin}): ${reason}`,
  }, transaction);
  return { intact: false, invalidated: true, skipped: false, cancelledJobs: cancelled.length, itemId: item.id, reason, origin };
}

/** O erro 409 do livro para quem tentou agendar ou publicar com a aprovação invalidada. */
function approvalInvalidatedError(check) {
  return approvalInvalidated({ contentItemId: check.itemId, cancelledJobs: check.cancelledJobs, reason: check.reason });
}

module.exports = { GUARDED_STATUSES, recordApprovedHash, checkApproval, approvalInvalidatedError };
