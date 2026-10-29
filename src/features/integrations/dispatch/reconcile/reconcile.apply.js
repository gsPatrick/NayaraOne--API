'use strict';

const { applyTransition } = require('../dispatch.transition');
const { confirmDispatch } = require('../worker/worker.confirm');
const { classifyExternalStatus } = require('./reconcile.outcome');
const { reportDispatchError, publishFailed, MENSAGENS } = require('../retry/retry.report');
const { sendToDeadLetter } = require('../retry/retry.deadLetter');
const { sendUnresolvedToDeadLetter } = require('./reconcile.deadLetter');
const { waitBeforeAttemptS } = require('./reconcile.params');
const { backoffMs } = require('../retry/retry.delay');
const { auditReconcile } = require('./reconcile.audit');
const { visao } = require('../dispatch.audit');

/** Visão do envio na auditoria da reconciliação: a de sempre mais o contador de consultas e o motivo da fila morta. */
const view = (row) => ({ ...visao(row), reconcileAttempts: row.reconcileAttempts, deadLetterReason: row.deadLetterReason || null });

/**
 * O recurso EXISTE no fornecedor (M9-D215 3.2): status final de sucesso -> CONFIRMED (evidência: consulta ou webhook assinado, uma vez só);
 * status final de recusa -> FAILED com aviso ao domínio; em andamento -> SUBMITTED (o webhook ou a consulta de status fecham depois).
 * Vale para UNKNOWN e, quando o evento chega depois da consulta, para SUBMITTED. Envio já CONFIRMED não muda (o primeiro vence).
 */
async function applyFound(ctx, row, found, { source }, transaction) {
  const destino = classifyExternalStatus(found.status);
  const ids = {
    externalResourceId: found.externalResourceId || undefined, externalRequestId: found.externalRequestId || undefined, externalStatus: String(found.status).slice(0, 64),
  };
  if (destino === 'CONFIRMED') {
    const r = await confirmDispatch(ctx, row.id, { source, status: found.status, externalResourceId: found.externalResourceId }, transaction);
    return { state: 'CONFIRMED', changed: r.confirmed, row: r.dispatch };
  }
  if (destino === 'FAILED') {
    await applyTransition(ctx, row, 'FAILED', { ...ids, lastErrorClass: 'VALIDATION', lastErrorCode: `EXTERNAL_${String(found.status).toUpperCase()}`.slice(0, 64) }, { motivo: `O fornecedor informou ${found.status}: operação não concluída.` }, transaction);
    await reportDispatchError(ctx, row, { errorClass: 'VALIDATION', errorCode: `EXTERNAL_${String(found.status).toUpperCase()}`.slice(0, 64), severity: 'MEDIUM', message: MENSAGENS.EXTERNAL_FAILED }, transaction);
    await publishFailed(ctx, row, { errorClass: 'VALIDATION', errorCode: `EXTERNAL_${String(found.status).toUpperCase()}`, status: 'FAILED' }, transaction);
    return { state: 'FAILED', changed: true, row };
  }
  if (row.status === 'UNKNOWN') {
    await applyTransition(ctx, row, 'SUBMITTED', ids, { motivo: `Fornecedor tem o recurso em andamento (${found.status}).` }, transaction);
    return { state: 'SUBMITTED', changed: true, row };
  }
  await row.update({ externalStatus: ids.externalStatus }, { transaction });
  return { state: row.status, changed: false, row };
}

/** O fornecedor afirmou que NÃO há registro: só então a operação perigosa pode sair de novo, com a MESMA chave de idempotência. */
async function applyNotFound(ctx, row, { now }, transaction) {
  const cls = { class: 'UNKNOWN', code: 'RECONCILED_NOT_FOUND' };
  if (row.attempts >= row.maxAttempts) {
    await sendToDeadLetter(ctx, row, cls, undefined, transaction);
    return { state: 'DEAD_LETTER', changed: true, row };
  }
  await applyTransition(ctx, row, 'RETRY_WAIT', { lastErrorClass: 'UNKNOWN', lastErrorCode: cls.code, nextAttemptAt: now }, { reconciled: true, motivo: 'O fornecedor não tem registro da operação: nova tentativa com a mesma chave de idempotência.' }, transaction);
  return { state: 'RETRY_WAIT', changed: true, row };
}

/** Sem resposta conclusiva: continua UNKNOWN com a próxima consulta marcada; esgotadas as consultas, fila morta e revisão humana. */
async function applyInconclusive(ctx, row, { now, params, trail }, transaction) {
  const feitas = row.reconcileAttempts + 1;
  if (feitas >= params.maxAttempts) {
    await sendUnresolvedToDeadLetter(ctx, row, { reconcileAttempts: feitas, trail }, transaction);
    return { state: 'DEAD_LETTER', changed: true, row };
  }
  await row.update({ reconcileAttempts: feitas, nextAttemptAt: new Date(now.getTime() + waitBeforeAttemptS(params, feitas) * 1000) }, { transaction });
  return { state: 'UNKNOWN', changed: false, row };
}

/** Envio de operação SAFE em UNKNOWN: repete com backoff (limite de tentativas pelo max_attempts do envio). */
async function applySafeRetry(ctx, row, { now, policy }, transaction) {
  const cls = { class: 'UNKNOWN', code: row.lastErrorCode || 'UNCLASSIFIED' };
  if (row.attempts >= row.maxAttempts) {
    await sendToDeadLetter(ctx, row, cls, undefined, transaction);
    return { state: 'DEAD_LETTER', changed: true, row };
  }
  await applyTransition(ctx, row, 'RETRY_WAIT', { nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts, policy.retry)) }, { motivo: 'Operação segura em estado incerto: nova tentativa com backoff.' }, transaction);
  return { state: 'RETRY_WAIT', changed: true, row };
}

/** Grava a auditoria da reconciliação com o antes (estado ao travar) e o depois (estado final). */
async function recordOutcome(ctx, before, result, { verdict, trail, source, reason }, transaction) {
  await auditReconcile(ctx, {
    dispatchId: result.row.id, before, after: view(result.row), result: verdict, trail, source,
    reason: reason || `Reconciliação (${verdict}): ${before.status} -> ${result.state}.`,
  }, transaction);
}

module.exports = { view, applyFound, applyNotFound, applyInconclusive, applySafeRetry, recordOutcome };
