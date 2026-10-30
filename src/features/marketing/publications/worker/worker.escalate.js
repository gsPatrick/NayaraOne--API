'use strict';

const { Notification } = require('../../../../models');
const { transition } = require('./worker.record');

const ESCALATED_CODE = 'MKT_PUBLICATION_UNKNOWN_ESCALATED';
const ESCALATED_MESSAGE = 'Publicação sem confirmação; decisão humana necessária.';

const addSeconds = (date, s) => new Date(date.getTime() + s * 1000);
const HOUR_MS = 60 * 60 * 1000;

/** Passou do limite (`marketing.worker.reconcile_max_h`) sem confirmação e ainda não foi escalado? */
const shouldEscalate = (ctx, job, since) => !job.escalated_at && since && ctx.now.getTime() - new Date(since).getTime() >= ctx.params.reconcileMaxH * HOUR_MS;

/**
 * Alerta CRÍTICO de publicação sem confirmação (M9-D411 item 6): auditoria `marketing.publication.unknown_escalated`, `last_error_code` MKT_PUBLICATION_UNKNOWN_ESCALATED
 * e notificação a quem agendou (`created_by` do job). Uma vez só por job. NÃO republica e NÃO muda o status: a decisão é humana (cancelar o job e, se preciso, agendar de novo
 * com chave nova); a reconciliação continua no mesmo intervalo, e se o canal voltar e mostrar o post, o job é resolvido sem ninguém.
 */
async function escalate(ctx, job, reason) {
  await transition(ctx, job, { lastErrorCode: ESCALATED_CODE, escalatedAt: ctx.now, nextCheckAt: addSeconds(ctx.now, ctx.params.reconcileS) }, { action: 'marketing.publication.unknown_escalated', reason: reason || ESCALATED_MESSAGE });
  if (!job.created_by) return { notified: false };
  await Notification.create({
    groupId: ctx.tenant.groupId, companyId: ctx.tenant.companyId, userId: job.created_by, channel: 'IN_APP', title: 'Publicação sem confirmação (crítico)',
    body: `${ESCALATED_MESSAGE} Canal ${job.channel}, publicação ${job.id}. Cancele a publicação e, se necessário, agende de novo.`, createdBy: null, updatedBy: null,
  }, { transaction: ctx.transaction });
  return { notified: true };
}

module.exports = { escalate, shouldEscalate, ESCALATED_CODE, ESCALATED_MESSAGE };
