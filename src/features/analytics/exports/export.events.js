'use strict';

/**
 * M9-D701 (3.3 e 3.5) — eventos `analytics.export.requested/ready/downloaded/expired` (outbox, na transação do dado), auditoria das etapas e o aviso
 * ao solicitante quando o arquivo fica pronto (motor de notificações existente, canal IN_APP, com o link; não existe rota de consulta de status).
 * Nenhum evento, auditoria ou aviso leva o conteúdo do arquivo: só código do alvo, linhas, hash e o job.
 */
const { Notification } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { hashIp } = require('../security');

const LINK = (jobId) => `/v1/analytics/exports/${jobId}/download`;

function publish(type, job, extra, transaction, keySuffix = '') {
  return publishDomainEvent({
    groupId: job.groupId, companyId: job.companyId, aggregateType: 'ExportJob', aggregateId: job.id, eventType: `analytics.export.${type}`, eventVersion: 1, classification: 'INTERNAL',
    payload: { jobId: job.id, requestedBy: job.requestedBy, ...extra }, idempotencyKey: `analytics.export.${type}:${job.id}${keySuffix}`,
  }, transaction);
}

function audit(action, job, { actorUserId, ip, before, after, reason }, transaction) {
  return registrarAuditoria({
    groupId: job.groupId, companyId: job.companyId, actorUserId: actorUserId || null, action: `analytics.export.${action}`, entityType: 'analytics.export_job', entityId: job.id,
    beforeJson: before || null, afterJson: { ...(after || {}), ipHash: hashIp(ip) }, reason,
  }, transaction);
}

async function notifyReady(job, fileName, transaction) {
  await Notification.create({
    groupId: job.groupId, companyId: job.companyId, userId: job.requestedBy, channel: 'IN_APP',
    title: 'Sua exportação está pronta',
    body: `O arquivo ${fileName} (${job.rowCount} linhas) está pronto e vale até ${new Date(job.expiresAt).toISOString()}. Baixe pelo link: ${LINK(job.id)}.`,
  }, { transaction });
}

module.exports = { publish, audit, notifyReady, LINK };
