'use strict';

const { IntegrationDispatch, AuditLog } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { redactDeep } = require('../../../shared/redaction');
const { q, SELECT } = require('../health/healthStore');
const { AUDIT_ACTION, ENTITY_TYPE } = require('../dispatch/dispatch.constants');
const { parseUuid } = require('./admin.query');
const { brtDeep } = require('./admin.format');

const notFound = () => AppError.notFound('Envio não encontrado.', 'INTEGRATION_DISPATCH_NOT_FOUND');

/** A linha do tempo vem da auditoria (cada mudança de estado grava antes e depois, com o motivo). */
async function readTimeline(dispatchId, ctx, transaction) {
  const rows = await AuditLog.findAll({
    where: { companyId: ctx.companyId, entityType: ENTITY_TYPE, entityId: dispatchId, action: AUDIT_ACTION },
    order: [['occurred_at', 'ASC'], ['created_at', 'ASC']],
    transaction,
  });
  return rows.map((a) => ({
    at: a.occurredAt,
    from: a.beforeJson && a.beforeJson.status ? a.beforeJson.status : null,
    to: a.afterJson ? a.afterJson.status : null,
    reason: a.reason,
    actorUserId: a.userId,
  }));
}

async function readAttempts(dispatchId, transaction) {
  const rows = await q('SELECT * FROM "integration"."dispatch_attempts" WHERE dispatch_id = :id ORDER BY attempt_no ASC, started_at ASC', { id: dispatchId }, transaction, SELECT);
  return rows.map((r) => ({
    attemptNo: r.attempt_no, startedAt: r.started_at, finishedAt: r.finished_at, outcome: r.outcome,
    errorClass: r.error_class, errorCode: r.error_code, httpStatus: r.http_status, latencyMs: r.latency_ms,
  }));
}

/**
 * GET /admin/integrations/dispatches/:id (M9-D249): o envio com a linha do tempo, as tentativas e os vínculos. O conteúdo do envio
 * (já minimizado pela M9-D219) sai SEMPRE pela redaction da M9-D246. Envio de outra empresa não existe para quem pede: 404.
 */
async function getDispatchDetail(id, ctx, transaction) {
  parseUuid(id, 'id');
  const d = await IntegrationDispatch.findOne({ where: { id, companyId: ctx.companyId }, transaction });
  if (!d) throw notFound();
  const [timeline, attempts] = await Promise.all([readTimeline(d.id, ctx, transaction), readAttempts(d.id, transaction)]);
  return brtDeep({
    id: d.id,
    connectionId: d.connectionId,
    provider: d.providerCode,
    operation: d.operation,
    opClass: d.criticalityOp,
    status: d.status,
    payloadHash: d.payloadHash,
    idempotencyKey: d.idempotencyKey,
    externalRequestId: d.externalRequestId,
    externalResourceId: d.externalResourceId,
    attemptsUsed: d.attempts,
    maxAttempts: d.maxAttempts,
    nextAttemptAt: d.nextAttemptAt,
    lastErrorClass: d.lastErrorClass,
    lastErrorCode: d.lastErrorCode,
    lastHttpStatus: d.lastHttpStatus,
    aggregate: d.aggregateType || d.aggregateId ? { type: d.aggregateType, id: d.aggregateId } : null,
    payloadSnapshot: redactDeep(d.payloadSnapshot),
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    timeline,
    attempts,
  });
}

module.exports = { getDispatchDetail };
