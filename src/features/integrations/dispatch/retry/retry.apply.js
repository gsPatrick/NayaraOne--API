'use strict';

const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const { findCurrentRow } = require('../../health/healthStore');
const { applyTransition } = require('../dispatch.transition');
const { backoffMs } = require('./retry.delay');
const { reportDispatchError, publishFailed, annotateAttempt, MENSAGENS } = require('./retry.report');
const { sendToDeadLetter } = require('./retry.deadLetter');
const { getUnknownReconciler } = require('./retry.unknown');

const MAX_RECONCILE_PADRAO = 5;
const errPatch = (cls, httpStatus) => ({ lastErrorClass: cls.class, lastErrorCode: cls.code, lastHttpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined });

/** TRANSIENT: backoff exponencial com jitter; na última tentativa vai à fila morta. */
async function applyTransient(h, cls) {
  const { ctx, dispatch, policy, now, httpStatus, transaction } = h;
  if (dispatch.attempts >= dispatch.maxAttempts) return sendToDeadLetter(ctx, dispatch, cls, httpStatus, transaction);
  const atraso = backoffMs(dispatch.attempts, policy.retry);
  return applyTransition(ctx, dispatch, 'RETRY_WAIT', { ...errPatch(cls, httpStatus), nextAttemptAt: new Date(now.getTime() + atraso) }, { motivo: `Falha transitória: nova tentativa em ${Math.round(atraso / 1000)} s.` }, transaction);
}

async function countRateLimited(dispatchId, transaction) {
  const [rows] = await sequelize.query('SELECT count(*)::int AS n FROM "integration"."dispatch_attempts" WHERE dispatch_id = :id AND rate_limited', { replacements: { id: dispatchId }, transaction });
  return rows[0].n;
}

/**
 * RATE_LIMIT: espera o Retry-After (limitado a `rate_limit_max_wait_s`); sem ele, a renovação da cota (`quota_resets_at` da saúde); sem
 * nenhum, o backoff transitório. NÃO conta como falha (devolve a tentativa). Acima do teto de adiamentos seguidos conta como transitório.
 */
async function applyRateLimit(h, cls) {
  const { ctx, dispatch, connection, policy, now, httpStatus, transaction } = h;
  await annotateAttempt(h.attemptId, { errorClass: 'RATE_LIMIT', errorCode: cls.code, rateLimited: true }, transaction);
  const adiamentos = await countRateLimited(dispatch.id, transaction);
  if (adiamentos > policy.retry.rate_limit_max_deferrals) return applyTransient(h, { ...cls, class: 'TRANSIENT' });
  const teto = policy.retry.rate_limit_max_wait_s * 1000;
  let espera = Number.isFinite(cls.retryAfterMs) ? cls.retryAfterMs : null;
  if (espera === null) {
    const saude = await findCurrentRow(connection.id, transaction);
    const renova = saude && saude.quota_resets_at ? new Date(saude.quota_resets_at).getTime() - now.getTime() : null;
    if (renova !== null && renova > 0) espera = renova;
  }
  const acimaDoTeto = espera !== null && espera > teto;
  if (espera === null) espera = backoffMs(adiamentos, policy.retry);
  if (acimaDoTeto) espera = teto;
  const saida = await applyTransition(ctx, dispatch, 'RETRY_WAIT', { ...errPatch(cls, httpStatus), nextAttemptAt: new Date(now.getTime() + espera) }, { refundAttempt: true, motivo: `Limite do fornecedor: espera de ${Math.round(espera / 1000)} s, sem gastar tentativa.` }, transaction);
  if (acimaDoTeto) {
    await reportDispatchError(ctx, dispatch, { errorClass: 'RATE_LIMIT', errorCode: 'INTEGRATION_RETRY_AFTER_EXCEEDS_CAP', severity: 'MEDIUM', message: MENSAGENS.RATE_LIMIT_CAP, httpStatus }, transaction);
  }
  return saida;
}

/** VALIDATION: nenhuma tentativa adicional; FAILED, erro MEDIUM e aviso ao domínio. */
async function applyValidation(h, cls) {
  const { ctx, dispatch, httpStatus, transaction } = h;
  await applyTransition(ctx, dispatch, 'FAILED', errPatch(cls, httpStatus), { motivo: 'Erro permanente de validação: sem nova tentativa.' }, transaction);
  await reportDispatchError(ctx, dispatch, { errorClass: 'VALIDATION', errorCode: cls.code, severity: 'MEDIUM', message: MENSAGENS.VALIDATION, httpStatus }, transaction);
  await publishFailed(ctx, dispatch, { errorClass: 'VALIDATION', errorCode: cls.code, status: 'FAILED' }, transaction);
  return dispatch;
}

/**
 * UNKNOWN: em operação perigosa o envio fica UNKNOWN e a reconciliação (D215) decide, nunca um retry cego; em operação segura
 * há tentativas limitadas (`integration.unknown.max_reconcile_attempts`, padrão 5) e depois a fila morta.
 */
async function applyUnknown(h, cls) {
  const { ctx, dispatch, policy, now, httpStatus, transaction } = h;
  const maximo = await getSetting('integration.unknown.max_reconcile_attempts', ctx, transaction, MAX_RECONCILE_PADRAO);
  const limite = Number.isInteger(maximo) && maximo >= 1 ? maximo : MAX_RECONCILE_PADRAO;
  if (dispatch.criticalityOp === 'DANGEROUS') {
    await applyTransition(ctx, dispatch, 'UNKNOWN', errPatch(cls, httpStatus), { motivo: 'Resposta incerta em operação perigosa: reconciliar antes de repetir.' }, transaction);
    await reportDispatchError(ctx, dispatch, { errorClass: 'UNKNOWN', errorCode: cls.code, severity: 'CRITICAL', message: MENSAGENS.UNKNOWN, httpStatus }, transaction);
    const reconciler = getUnknownReconciler();
    if (reconciler) await reconciler({ ctx, dispatch, classification: cls, transaction });
    return dispatch;
  }
  const usadas = dispatch.reconcileAttempts + 1;
  if (usadas >= limite || dispatch.attempts >= dispatch.maxAttempts) return sendToDeadLetter(ctx, dispatch, cls, httpStatus, transaction);
  const atraso = backoffMs(dispatch.attempts, policy.retry);
  return applyTransition(ctx, dispatch, 'RETRY_WAIT', { ...errPatch(cls, httpStatus), reconcileAttempts: usadas, nextAttemptAt: new Date(now.getTime() + atraso) }, { motivo: `Resposta incerta em operação segura: tentativa ${usadas} de ${limite}.` }, transaction);
}

module.exports = { applyTransient, applyRateLimit, applyValidation, applyUnknown };
