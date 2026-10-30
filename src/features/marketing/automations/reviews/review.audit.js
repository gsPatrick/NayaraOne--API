'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');

const ENTITY = 'marketing.review_request';
const view = (row) => (row ? { status: row.status, errorCode: row.error_code, channel: row.channel, score: row.satisfaction_score, feedbackCaseId: row.feedback_case_id, platform: row.platform, publicRating: row.public_rating } : null);

/** Auditoria antes e depois de cada mudança do pedido (sem dado pessoal: ids, nota, canal e estado). */
async function auditReview(tenant, actor, action, before, after, reason, transaction) {
  await registrarAuditoria({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor || null, action, entityType: ENTITY, entityId: after.id, beforeJson: view(before), afterJson: view(after), reason }, transaction);
}

module.exports = { auditReview };
