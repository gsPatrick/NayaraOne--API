'use strict';

const repo = require('./worker.repository');
const results = require('./worker.results');
const { transition, emitCompleted, emitFailed } = require('./worker.record');
const { statusKind, providerStatusOf } = require('./worker.status');
const { backoffFor } = require('./worker.settings');
const security = require('../../security');

const addSeconds = (date, s) => new Date(date.getTime() + s * 1000);
const messageOf = { MKT_PROVIDER_AUTH_FAILED: 'O provedor recusou a credencial; reconecte a conta.', MKT_PROVIDER_REJECTED: 'A rede recusou o conteúdo.', MKT_PUBLICATION_RETRIES_EXHAUSTED: 'As tentativas de publicação acabaram.', MKT_PUBLICATION_ADAPTER_EXCEPTION: 'Falha inesperada ao falar com o canal.', MKT_CAPABILITY_VIOLATION: 'O conteúdo excede um limite da rede escolhida.' };
/** O que se guarda da resposta do canal: status, erro reduzido (classe, código, HTTP), se é simulada e a decisão de contingência do canal (M9-D430); nunca o corpo bruto. */
const redactedResponse = (r) => ({
  status: r.status || null, error: r.error ? { class: r.error.class, code: r.error.code, httpStatus: r.error.httpStatus ?? null } : null, sandbox: Boolean(r.sandbox), replayed: Boolean(r.replayed),
  ...(r.contingency ? { contingency: { action: r.contingency.action, state: r.contingency.state, retry: r.contingency.retry } } : {}),
});

/** Falha definitiva (sem retry): FAILED com o código, resultado FAILURE e evento marketing.publication.failed. */
async function failDefinitive(ctx, job, code, { providerStatus = null, response = {} } = {}) {
  await results.insertResult(job, { outcome: 'FAILURE', attemptNo: job.attempts, providerStatus, response: { ...response, errorCode: code } }, ctx.transaction);
  await transition(ctx, job, { status: 'FAILED', lastErrorCode: code, providerStatus: providerStatus || undefined, nextAttemptAt: null, nextCheckAt: null, startedAt: null }, { action: 'marketing.publication.failed', reason: messageOf[code] || 'Publicação falhou.' });
  await emitFailed(ctx, job, code);
  return { to: 'FAILED', code };
}

/** Post aceito pelo canal: no ar -> PUBLISHED (evento completed); em processamento -> segue RUNNING e é consultado por getStatus; recusado -> FAILED com o motivo. */
async function acceptPost(ctx, job, { providerRef, status, externalUrl, outcome = 'SUCCESS', response = {} }) {
  const providerStatus = providerStatusOf(status);
  const kind = statusKind(status);
  if (kind === 'REJECTED') return failDefinitive(ctx, job, 'MKT_PROVIDER_REJECTED', { providerStatus, response });
  const base = { outcome, attemptNo: job.attempts, externalPostId: providerRef, externalUrl: externalUrl || null, providerStatus, response };
  await results.insertResult(job, base, ctx.transaction);
  const common = { externalPostId: providerRef, externalUrl: externalUrl || null, providerStatus, lastErrorCode: null, startedAt: null, unknownSince: null, nextAttemptAt: null };
  if (kind === 'LIVE') {
    await transition(ctx, job, { ...common, status: 'PUBLISHED', publishedAt: ctx.now, nextCheckAt: null }, { action: 'marketing.publication.published', reason: 'Publicação confirmada pelo canal.' });
    await emitCompleted(ctx, job, { externalPostId: providerRef, externalUrl });
    return { to: 'PUBLISHED' };
  }
  await transition(ctx, job, { ...common, status: 'RUNNING', startedAt: ctx.now, nextCheckAt: addSeconds(ctx.now, ctx.params.reconcileS) }, { action: 'marketing.publication.processing', reason: 'O canal aceitou o post e ainda o está processando.' });
  return { to: 'RUNNING', processing: true };
}

/** Timeout, resposta incerta ou falha inesperada: UNKNOWN, nunca retry direto. A reconciliação decide (findByIdempotencyKey). */
async function markUnknown(ctx, job, { code, response = {} }) {
  await results.insertResult(job, { outcome: 'TIMEOUT', attemptNo: job.attempts, response: { ...response, errorCode: code } }, ctx.transaction);
  await transition(ctx, job, { status: 'UNKNOWN', unknownSince: ctx.now, nextCheckAt: ctx.now, startedAt: null, lastErrorCode: code }, { action: 'marketing.publication.unknown', reason: 'Sem confirmação do canal; a reconciliação consulta antes de qualquer nova tentativa.' });
  return { to: 'UNKNOWN', code };
}

/** Nada saiu e a causa passa sozinha (kill switch, circuito aberto): volta a PENDING sem gastar tentativa, para ser pego no ciclo seguinte. */
async function release(ctx, job, code) {
  await transition(ctx, job, { status: 'PENDING', attempts: Math.max(job.attempts - 1, 0), startedAt: null, nextAttemptAt: null, lastErrorCode: code }, { action: 'marketing.publication.released', reason: 'Envio segurado; o job volta a PENDING sem gastar tentativa.' });
  return { to: 'PENDING', released: true };
}

/** Falha transitória conhecida: nova tentativa com espera por retentativa (a maior entre a espera e o Retry-After do canal) até o limite de tentativas; depois, FAILED. */
async function retryOrFail(ctx, job, code, { retryAfterMs = 0, response = {} } = {}) {
  if (job.attempts >= ctx.params.maxAttempts) return failDefinitive(ctx, job, 'MKT_PUBLICATION_RETRIES_EXHAUSTED', { response: { ...response, lastCode: code } });
  const waitS = Math.max(backoffFor(ctx.params.backoffS, job.attempts), Math.ceil(retryAfterMs / 1000));
  await results.insertResult(job, { outcome: 'FAILURE', attemptNo: job.attempts, response: { ...response, errorCode: code } }, ctx.transaction);
  await transition(ctx, job, { status: 'PENDING', startedAt: null, nextAttemptAt: addSeconds(ctx.now, waitS), lastErrorCode: code }, { action: 'marketing.publication.retry', reason: `Falha transitória do canal; nova tentativa em ${waitS} s.` });
  return { to: 'PENDING', retryInS: waitS };
}

/** Resposta do adapter -> destino do job. UNKNOWN antes de tudo; depois recusa/credencial (definitivas), falha transitória explícita (5xx, 429) e sucesso. */
async function applyResult(ctx, job, result) {
  const response = redactedResponse(result);
  if (result.unknown) return markUnknown(ctx, job, { code: (result.error && result.error.code) || 'UNKNOWN_RESPONSE', response });
  if (result.status === 'REJECTED') return failDefinitive(ctx, job, 'MKT_PROVIDER_REJECTED', { providerStatus: 'REJECTED', response });
  const error = result.error;
  if (error && error.class === 'AUTH') {
    // Credencial REVOGADA pelo provedor = conta comprometida (M9-D433): revoga, marca a conexão e trava o canal na mesma transação; o job falha como credencial recusada.
    if (security.isAuthRevoked(error)) await security.reportAuthRevoked({ tenant: ctx.tenant, channel: job.channel, transaction: ctx.transaction, now: ctx.now });
    return failDefinitive(ctx, job, 'MKT_PROVIDER_AUTH_FAILED', { response });
  }
  if (error && error.class === 'VALIDATION') return failDefinitive(ctx, job, 'MKT_PROVIDER_REJECTED', { response });
  const noRetry = result.contingency && result.contingency.retry === 'NONE'; // decideOnResult (M9-D430): repetir não adianta para esta classe de erro
  if (error && ['TRANSIENT', 'RATE_LIMIT'].includes(error.class) && error.httpStatus && !noRetry) return retryOrFail(ctx, job, error.code || 'HTTP_5XX', { retryAfterMs: error.retryAfterMs, response });
  if (error || !result.providerRef) return markUnknown(ctx, job, { code: (error && error.code) || 'NO_REFERENCE', response });
  return acceptPost(ctx, job, { providerRef: result.providerRef, status: result.status, externalUrl: result.externalUrl, response });
}

/**
 * Aplica o que o envio devolveu. O job é relido com trava: só vale se ainda for a MESMA tentativa em RUNNING (se a varredura de recuperação o levou a UNKNOWN
 * enquanto o envio demorava, o resultado tardio é descartado e a reconciliação resolve pelo canal).
 */
async function applySend(ctx, claimed, sent) {
  const job = await repo.lockById(claimed.id, ctx.transaction);
  if (!job || job.status !== 'RUNNING' || job.attempts !== claimed.attempts) return { skipped: true };
  if (sent.kind === 'RELEASE') return release(ctx, job, sent.code);
  if (sent.kind === 'TIMEOUT') return markUnknown(ctx, job, { code: 'TIMEOUT' });
  if (sent.kind === 'EXCEPTION') return markUnknown(ctx, job, { code: sent.code });
  if (sent.kind === 'DEFINITIVE') return failDefinitive(ctx, job, sent.code);
  if (sent.kind === 'NOT_SENT') return retryOrFail(ctx, job, sent.code);
  return applyResult(ctx, job, sent.result);
}

module.exports = { applySend, applyResult, acceptPost, failDefinitive, markUnknown, retryOrFail, release };
