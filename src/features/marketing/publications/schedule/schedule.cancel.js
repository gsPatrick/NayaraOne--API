'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const jobs = require('./schedule.jobs');
const { cancelSocialDispatches } = require('./schedule.social');
const { recomputeItemStatus } = require('./schedule.status');
const { jobNotCancellable, jobNotFound } = require('./schedule.errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_REASON = 'Cancelamento manual da publicação.';
const MAX_REASON = 500;

/**
 * Motivo pelo qual o job não pode ser cancelado (null = pode). PENDING cancela; UNKNOWN só depois da reconciliação (M9-D411: resultado
 * RECONCILED_NOT_FOUND gravado, ou seja, conferido na rede que o post não existe) ou depois do alerta crítico de UNKNOWN escalado (decisão humana); RUNNING, PUBLISHED, FAILED e CANCELLED nunca.
 */
async function refusalOf(job, transaction) {
  if (job.status === 'PENDING') return null;
  if (job.status === 'UNKNOWN') return job.escalated_at || (await jobs.hasReconciliation(job.id, transaction)) ? null : 'UNKNOWN_NOT_RECONCILED';
  return `STATUS_${job.status}`;
}

/**
 * POST /marketing/publications/:id/cancel (M9-D410 item 4): PENDING (ou UNKNOWN já reconciliado) -> CANCELLED com motivo; o envio social ainda PENDING também
 * é cancelado; o status do item é recalculado (todos cancelados: SCHEDULED -> APPROVED). Trava o item antes do job (mesma ordem do agendamento).
 */
async function cancelJob({ tenant, actor, jobId, reason }, transaction) {
  if (!UUID_RE.test(String(jobId))) throw jobNotFound();
  const itemId = await jobs.itemOf(jobId, transaction);
  if (!itemId) throw jobNotFound();
  await require('../../content').service.repo.lockItem(itemId, transaction);
  const job = await jobs.lockJob(jobId, transaction);
  if (!job) throw jobNotFound();
  const refusal = await refusalOf(job, transaction);
  if (refusal) throw jobNotCancellable({ jobId, status: job.status, reason: refusal });
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, MAX_REASON) : DEFAULT_REASON;
  await jobs.setStatus(job.id, 'CANCELLED', 'MANUAL_CANCEL', actor, transaction);
  const dispatches = await cancelSocialDispatches({ tenant, actor, job, itemId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.publication.cancel', entityType: 'MarketingPublicationJob', entityId: job.id,
    beforeJson: { status: job.status, channel: job.channel, scheduledAt: job.scheduled_at }, afterJson: { status: 'CANCELLED', cancelledDispatchIds: dispatches }, reason: text,
  }, transaction);
  const item = await recomputeItemStatus({ tenant, actor, itemId, reason: text }, transaction);
  return { jobId: job.id, status: 'CANCELLED', channel: job.channel, itemId, itemStatus: item.status, cancelledDispatchIds: dispatches };
}

module.exports = { cancelJob, refusalOf };
