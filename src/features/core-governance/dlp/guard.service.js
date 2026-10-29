'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../../engines/audit/auditLog.service');
const { publishGovernanceEvent } = require('../governance.events');
const { evaluate, isLight } = require('./dlp.guard');
const { normalize } = require('./guard.input');
const { buildContext } = require('./guard.context');
const { withOwnTenantTransaction } = require('./guard.tx');
const { emitSignal } = require('./signals.sink');
const { idempotencyConflict } = require('./dlp.errors');
const jobs = require('./exportJob.repository');
const viewAudit = require('./view.audit');

const jobView = (row) => (row ? {
  id: row.id, kind: row.kind, action: row.action, resourceType: row.resourceType, classification: row.classification, purpose: row.purpose, justification: row.justification,
  estimatedRows: row.estimatedRows, status: row.status, blockReason: row.blockReason, decisionTrace: row.decisionTrace, obligations: row.obligations,
  expiresAt: row.expiresAt, actorUserId: row.actorUserId, idempotencyKey: row.idempotencyKey, requestedAt: row.requestedAt, decidedAt: row.decidedAt,
} : null);

const AUDIT_PREFIX = 'governance.dlp.';

async function audit(tenant, req, result, entityId, transaction) {
  const base = {
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: req.actorUserId, action: `${AUDIT_PREFIX}${req.action.toLowerCase()}`, entityType: 'ExportJob', entityId,
  };
  const details = { action: req.action, resourceType: req.resourceType, classification: result.classification, decision: result.decision, blockReason: result.blockReason, trace: result.trace };
  if (result.decision === 'DENY') {
    return registrarTentativaBloqueada({ ...base, beforeJson: details, reason: `Pedido de ${req.action} bloqueado pelo DLP (${result.blockReason}).` }, transaction);
  }
  return registrarAuditoria({ ...base, beforeJson: null, afterJson: details, reason: `Pedido de ${req.action} liberado pelo DLP.` }, transaction);
}

/** Sinal de acesso (M9-D824) de uma decisão do guard, leve ou completa. */
const signalOf = (req, result, occurredAt) => ({
  actorUserId: req.actorUserId, action: req.action, classification: result.classification, decision: result.decision, blockReason: result.blockReason, resourceType: req.resourceType, occurredAt,
  count: Array.isArray(req.resourceIds) && req.resourceIds.length ? req.resourceIds.length : 1,
});

/** Resposta quando a Idempotency-Key já existe: o mesmo pedido (a chave com outro corpo é 409). */
function replay(existing, req) {
  if (existing.requestHash !== req.requestHash) throw idempotencyConflict();
  const blocked = existing.status === 'BLOCKED';
  const trace = existing.decisionTrace || [];
  return {
    decision: blocked ? 'DENY' : (existing.status === 'FAILED' ? null : 'ALLOW'), blockReason: existing.blockReason, classification: existing.classification, mode: 'FULL', trace,
    obligations: existing.obligations, job: jobView(existing), replayed: true,
  };
}

/** EXPORT, SHARE e PRINT: grava o pedido ANTES de tudo, avalia, grava a decisão, audita e publica o bloqueio, tudo numa transação própria. */
async function decideFull(tenant, req) {
  const outcome = await withOwnTenantTransaction(tenant, req.actorUserId, async (transaction) => {
    const created = await jobs.insertRequested(tenant, req, transaction);
    if (!created) return { existing: await jobs.findByKey(tenant.companyId, req.idempotencyKey, transaction) };
    try {
      return await sequelize.transaction({ transaction }, async (savepoint) => {
        const context = await buildContext(tenant, req, savepoint);
        const result = evaluate(req, context);
        const job = await jobs.finalize(tenant.companyId, created.id, result, savepoint);
        if (result.decision === 'DENY') {
          await publishGovernanceEvent({
            groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'ExportJob', aggregateId: job.id, eventType: 'dlp.export.blocked',
            payload: { exportJobId: job.id, actor: req.actorUserId, classification: result.classification, blockReason: result.blockReason }, idempotencyKey: `dlp.export.blocked:${job.id}`,
          }, savepoint);
        }
        if (result.decision === 'DENY' || context.policy.requireAudit) await audit(tenant, req, result, job.id, savepoint);
        await emitSignal(tenant, signalOf(req, result, context.now), savepoint);
        return { result: { ...result, job: jobView(job), justificationMin: context.justificationMin } };
      });
    } catch (error) {
      await jobs.markFailed(tenant.companyId, created.id, error, transaction);
      return { error };
    }
  });
  if (outcome.error) throw outcome.error;
  return outcome.existing ? replay(outcome.existing, req) : outcome.result;
}

/** VIEW, COPY e AI (modo leve, §3.1b): sem export_job; audita o que a política exige (e todo bloqueio) e entrega o sinal de acesso. */
async function decideLight(tenant, req) {
  return withOwnTenantTransaction(tenant, req.actorUserId, async (transaction) => {
    const context = await buildContext(tenant, req, transaction);
    const result = evaluate(req, context);
    let auditId = null;
    if (req.action === 'VIEW') {
      if (result.decision === 'DENY' || context.policy.requireAudit) await viewAudit.recordView(tenant, req, result, transaction);
    } else if (result.decision === 'DENY' || context.policy.requireAudit) {
      auditId = (await audit(tenant, req, result, null, transaction)).id;
    }
    await emitSignal(tenant, signalOf(req, result, context.now), transaction);
    return { ...result, job: null, auditId, justificationMin: context.justificationMin };
  });
}

/**
 * Porteiro único (M9-D821): `decide(tenant, pedido)` devolve { decision, blockReason, errorCode, httpStatus, classification, mode, trace, obligations, job }. Quem chama
 * lança `blockedError(decision)` (guard.reasons.js) quando for DENY. O pedido bloqueado continua gravado (BLOCKED) e o evento dlp.export.blocked sai uma vez.
 */
async function decide(tenant, raw) {
  const req = normalize(raw, tenant);
  return isLight(req.action) ? decideLight(tenant, req) : decideFull(tenant, req);
}

async function getJob(tenant, id) {
  return withOwnTenantTransaction(tenant, tenant.userId, async (transaction) => jobView(await jobs.findById(tenant.companyId, id, transaction)));
}

module.exports = { decide, getJob, jobView };
