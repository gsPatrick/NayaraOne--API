'use strict';

const { IntegrationDispatch } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { applyTransition } = require('../dispatch/dispatch.transition');
const { assertPublishable } = require('./social.gate');
const { parseContentRef } = require('./social.payload');
const { enqueueOne, parseSchedule, OPERATION, AGGREGATE } = require('./social.publish');
const { slotOf } = require('./social.key');
const errors = require('./social.errors');

/**
 * rescheduleSocialPost — reagenda um post de UMA rede (M9-D239 3.2 item 4b). O horário novo muda a chave; por isso o envio anterior é
 * CANCELADO explicitamente (nunca ficam dois posts do mesmo conteúdo na mesma rede) e o novo nasce com a chave nova. Só dá enquanto o
 * envio não saiu (PENDING ou RETRY_WAIT sem id externo); o que já saiu, está em andamento ou tem resultado incerto é 409. Reagendar para o
 * mesmo horário devolve o mesmo envio. `args`: { dispatchId, scheduledAt, transaction }.
 */
async function rescheduleSocialPost(ctx, { dispatchId, scheduledAt, transaction }) {
  const novo = parseSchedule(scheduledAt);
  const row = await IntegrationDispatch.findOne({ where: { id: dispatchId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row || row.operation !== OPERATION || row.aggregateType !== AGGREGATE) throw AppError.notFound('Publicação não encontrada.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  const ref = parseContentRef((row.payloadSnapshot || {}).contentRef);
  if (!ref) throw AppError.notFound('Publicação não encontrada.', 'INTEGRATION_DISPATCH_NOT_FOUND');
  if (!['PENDING', 'RETRY_WAIT'].includes(row.status) || row.externalResourceId) throw errors.rescheduleNotAllowed();
  const slotAtual = (row.payloadSnapshot || {}).scheduledAt || 'IMMEDIATE';
  if (slotAtual === slotOf(novo)) return { dispatchId: row.id, status: row.status, created: false, replaced: false };
  const content = await assertPublishable(ctx, { itemId: ref.itemId, mode: ref.mode }, transaction, { lock: true });
  await applyTransition(ctx, row, 'CANCELLED', {}, { motivo: 'Publicação reagendada: o envio anterior foi cancelado.' }, transaction);
  const r = await enqueueOne(ctx, { content, mode: ref.mode, connectionId: row.connectionId, scheduledAt: novo }, transaction);
  return { ...r, replaced: true, cancelledDispatchId: row.id };
}

module.exports = { rescheduleSocialPost };
