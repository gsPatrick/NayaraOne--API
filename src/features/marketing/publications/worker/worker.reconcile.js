'use strict';

const { resolveChannelAdapter } = require('../adapters/release/channelAccess');
const repo = require('./worker.repository');
const results = require('./worker.results');
const { transition } = require('./worker.record');
const { acceptPost, markUnknown, failDefinitive } = require('./worker.outcome');
const { escalate, shouldEscalate } = require('./worker.escalate');
const { withTimeout } = require('./worker.call');
const { backoffFor } = require('./worker.settings');
const logger = require('../../../../utils/logger');

const addSeconds = (date, s) => new Date(date.getTime() + s * 1000);

/** Pergunta ao canal se o post com a chave do job existe. Devolve a resposta do adapter, ou null quando a própria consulta falhou (erro, prazo ou canal revogado). */
async function askChannel(ctx, job) {
  try {
    const adapter = await resolveChannelAdapter(job.channel, { tenant: ctx.tenant, transaction: ctx.transaction });
    const outcome = await withTimeout(adapter.findByIdempotencyKey(job.idempotency_key), ctx.params.timeoutS * 1000);
    if (outcome.timedOut || outcome.error) return null;
    const answer = outcome.value;
    return answer && answer.error ? null : answer;
  } catch (err) {
    logger.warn({ jobId: job.id, channel: job.channel, code: err && err.code }, 'marketing.publication.worker.reconcile_failed');
    return null;
  }
}

/**
 * Reconcilia UM job UNKNOWN antes de qualquer nova tentativa (M9-D411 item 6): achou -> RECONCILED_FOUND e job pelo status real do canal, sem segundo post; confirmou a
 * ausência -> RECONCILED_NOT_FOUND e só então volta a PENDING (a tentativa já conta; esperando o backoff) ou FAILED se as tentativas acabaram; a consulta também
 * falhou -> continua UNKNOWN e tenta de novo após `marketing.worker.reconcile_s`, escalando para decisão humana depois de `marketing.worker.reconcile_max_h`.
 */
async function reconcileOne(ctx, job) {
  const answer = await askChannel(ctx, job);
  if (answer && answer.found === true) {
    return acceptPost(ctx, job, { providerRef: answer.providerRef, status: answer.status, externalUrl: answer.externalUrl, outcome: 'RECONCILED_FOUND', response: { reconciled: true } });
  }
  if (answer && answer.found === false) {
    await results.insertResult(job, { outcome: 'RECONCILED_NOT_FOUND', attemptNo: job.attempts, response: { reconciled: true, found: false } }, ctx.transaction);
    const back = { ...job, status: 'UNKNOWN' };
    if (back.attempts >= ctx.params.maxAttempts) return failDefinitive(ctx, back, 'MKT_PUBLICATION_RETRIES_EXHAUSTED', { response: { reconciled: true } });
    await transition(ctx, back, { status: 'PENDING', unknownSince: null, nextCheckAt: null, lastErrorCode: 'MKT_RECONCILED_NOT_FOUND', escalatedAt: null }, { action: 'marketing.publication.reconciled_not_found', reason: 'O canal confirmou que o post não existe; o job volta a PENDING.' });
    const wait = backoffFor(ctx.params.backoffS, job.attempts);
    await repo.patch(job.id, { nextAttemptAt: addSeconds(ctx.now, wait) }, ctx.transaction);
    return { to: 'PENDING', reconciled: 'NOT_FOUND', retryInS: wait };
  }
  if (shouldEscalate(ctx, job, job.unknown_since)) return { to: 'UNKNOWN', escalated: true, ...(await escalate(ctx, job)) };
  await repo.patch(job.id, { nextCheckAt: addSeconds(ctx.now, ctx.params.reconcileS) }, ctx.transaction);
  return { to: 'UNKNOWN', reconciled: 'FAILED' };
}

/** Reconcilia os UNKNOWN vencidos (SKIP LOCKED: duas instâncias não reconciliam o mesmo job). */
async function reconcileDue(ctx) {
  const rows = await repo.selectUnknownDue({ now: ctx.now, limit: ctx.params.batch }, ctx.transaction);
  const outcomes = [];
  for (const job of rows) outcomes.push(await reconcileOne(ctx, job));
  return outcomes;
}

/** Job RUNNING sem post confirmado há mais de duas vezes o prazo do adapter (processo caiu no meio): vai a UNKNOWN e segue a reconciliação, nunca retry direto. */
async function recoverAbandoned(ctx) {
  const cutoff = addSeconds(ctx.now, -2 * ctx.params.timeoutS);
  const rows = await repo.selectAbandoned({ cutoff, limit: ctx.params.batch }, ctx.transaction);
  const outcomes = [];
  for (const job of rows) outcomes.push(await markUnknown(ctx, job, { code: 'MKT_RUNNING_ABANDONED', response: { reason: 'RUNNING_ABANDONED' } }));
  return outcomes;
}

module.exports = { reconcileDue, reconcileOne, recoverAbandoned, askChannel };
