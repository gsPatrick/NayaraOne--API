'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../../marketing.events');
const { CHECKS } = require('../../marketing.events.fields');
const repo = require('./worker.repository');

/**
 * Gravações comuns do worker (M9-D411): muda o job, deixa a auditoria com o antes e o depois (ator nulo: ação do sistema) e marca o item da versão para ter o status
 * recalculado depois que a transação do worker termina (o recálculo trava o item, e o worker nunca espera o item enquanto segura um job). `ctx` = { tenant, transaction, touched }.
 */
const auditView = (job) => ({ status: job.status, attempts: job.attempts, providerStatus: job.provider_status || null, lastErrorCode: job.last_error_code || null, externalPostId: job.external_post_id || null });

async function transition(ctx, job, fields, { action, reason }) {
  await repo.patch(job.id, fields, ctx.transaction);
  const after = { ...auditView(job), ...Object.fromEntries(Object.entries({ status: fields.status, attempts: fields.attempts, providerStatus: fields.providerStatus, lastErrorCode: fields.lastErrorCode, externalPostId: fields.externalPostId }).filter(([, v]) => v !== undefined)) };
  await registrarAuditoria({
    groupId: ctx.tenant.groupId, companyId: ctx.tenant.companyId, actorUserId: null, action, entityType: 'MarketingPublicationJob', entityId: job.id,
    beforeJson: { ...auditView(job), channel: job.channel }, afterJson: { ...after, channel: job.channel }, reason,
  }, ctx.transaction);
  ctx.touched.add(job.item_id);
}

const codeOrNull = (value) => (CHECKS.nullableCode(value === undefined ? null : value) ? (value === undefined ? null : value) : null);
const urlOrNull = (value) => (typeof value === 'string' && CHECKS.nullableUrl(value) ? value : null);

/** marketing.publication.completed: só quando o post está no ar (LIVE). Id ou endereço fora do formato do catálogo seguem nulos no evento e inteiros no job. */
const emitCompleted = (ctx, job, post) => publishMarketingEvent({
  type: 'marketing.publication.completed', tenant: ctx.tenant,
  payload: { jobId: job.id, contentId: job.item_id, channel: job.channel, externalPostId: codeOrNull(post.externalPostId), externalUrl: urlOrNull(post.externalUrl) },
}, ctx.transaction);

const emitFailed = (ctx, job, errorCode) => publishMarketingEvent({
  type: 'marketing.publication.failed', tenant: ctx.tenant, payload: { jobId: job.id, channel: job.channel, errorCode },
}, ctx.transaction);

module.exports = { transition, emitCompleted, emitFailed, auditView };
