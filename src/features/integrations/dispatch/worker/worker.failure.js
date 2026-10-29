'use strict';

const { applyTransition } = require('../dispatch.transition');
const { finishAttempt } = require('./worker.attempts');
const { getFailureHandler } = require('./worker.hooks');

/** Classificação do erro pelo adapter (`classifyError`); se o adapter falhar em classificar, a falha é UNKNOWN. */
function classifyWithAdapter(adapter, error) {
  try {
    const c = adapter && adapter.classifyError ? adapter.classifyError(error) : null;
    if (c && typeof c.class === 'string') return c;
  } catch { /* cai no UNKNOWN */ }
  return { class: 'UNKNOWN', code: 'UNCLASSIFIED' };
}

/**
 * Falha da chamada: grava o resultado da tentativa e entrega a falha classificada ao tratador registrado (retry por classe, M9-D216).
 * Sem tratador, o envio vai a FAILED com a classe, sem nova tentativa.
 */
async function handleFailure({ ctx, dispatch, def, adapter, error, classification, attemptId, latencyMs, now, transaction }) {
  const base = classification || classifyWithAdapter(adapter, error);
  const httpStatus = Number(error && (error.status ?? error.statusCode ?? error.details?.status ?? error.response?.status));
  await finishAttempt(attemptId, {
    outcome: 'ERROR', errorClass: base.class, errorCode: base.code, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null, latencyMs,
  }, transaction);
  const handler = getFailureHandler();
  if (handler) return handler({ ctx, dispatch, def, adapter, error, classification: base, attemptId, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null, now, transaction });
  return applyTransition(ctx, dispatch, 'FAILED', {
    lastErrorClass: base.class, lastErrorCode: base.code, lastHttpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined,
  }, { motivo: `Falha ${base.class} sem política de nova tentativa.` }, transaction);
}

module.exports = { handleFailure, classifyWithAdapter };
