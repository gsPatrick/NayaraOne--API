'use strict';

const { IntegrationWebhookInbox } = require('../../../../models');
const { readInboxParams } = require('../../inbox/inbox.params');
const { requeueDeadLetter } = require('../../inbox/inbox.requeue');
const { REASON_EXHAUSTED } = require('../../inbox/inbox.constants');
const { notAllowed, payloadGone } = require('./retry.errors');

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Retry de um erro WEBHOOK (M9-D250 3.1 item 3): reenfileira o evento da fila morta SÓ por causa transitória (`ATTEMPTS_EXHAUSTED`) e enquanto o conteúdo ainda existe
 * (janela integration.inbox.dlq_retry_retention_days). Motivo de dado inválido, janela vencida ou conteúdo já apagado: 410 INTEGRATION_RETRY_PAYLOAD_GONE, porque
 * nesses casos o conteúdo nunca existe ou não existe mais (o que a pessoa faz é pedir o reenvio ao fornecedor). O evento fica pelo `source_ref_id` do erro, travado com FOR UPDATE.
 */
async function retryWebhookError(ctx, error, { reason }, params, transaction, { now = new Date() } = {}) {
  const row = error.financingCaseId
    ? await IntegrationWebhookInbox.findOne({ where: { id: error.financingCaseId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE })
    : null;
  if (!row) throw payloadGone();
  if (row.status !== 'DEAD_LETTER') throw notAllowed({ inboxStatus: row.status });
  if (row.deadLetterReason !== REASON_EXHAUSTED) throw payloadGone(); // dado inválido: o conteúdo nem foi guardado
  const inbox = await readInboxParams(ctx, transaction);
  const venceu = new Date(row.receivedAt).getTime() < now.getTime() - inbox.dlqRetryRetentionDays * DIA_MS;
  if (!row.payloadRaw || venceu) throw payloadGone();
  await requeueDeadLetter(ctx, row, { maxAttempts: inbox.maxAttempts, extraAttempts: params.humanExtraAttempts, reason }, transaction);
  return { inboxId: row.id };
}

module.exports = { retryWebhookError };
