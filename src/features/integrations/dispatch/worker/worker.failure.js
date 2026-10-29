'use strict';

const { applyTransition } = require('../dispatch.transition');
const { finishAttempt } = require('./worker.attempts');
const { getFailureHandler } = require('./worker.hooks');
const { recordCallResult } = require('../../health/circuitBreaker');

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
async function handleFailure({ ctx, dispatch, connection, probe = false, def, adapter, error, classification, attemptId, latencyMs, now, transaction }) {
  const base = classification || classifyWithAdapter(adapter, error);
  const httpStatus = Number(error && (error.status ?? error.statusCode ?? error.details?.status ?? error.response?.status));
  await finishAttempt(attemptId, {
    outcome: 'ERROR', errorClass: base.class, errorCode: base.code, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null, latencyMs,
  }, transaction);
  const handler = getFailureHandler();
  const httpOuNulo = Number.isInteger(httpStatus) ? httpStatus : null;
  const saida = handler
    ? await handler({ ctx, dispatch, def, adapter, error, classification: base, attemptId, httpStatus: httpOuNulo, now, transaction })
    : await applyTransition(ctx, dispatch, 'FAILED', {
      lastErrorClass: base.class, lastErrorCode: base.code, lastHttpStatus: httpOuNulo ?? undefined,
    }, { motivo: `Falha ${base.class} sem política de nova tentativa.` }, transaction);
  // Circuito (M9-D217): vale a classe FINAL da falha (a política de nova tentativa pode ter reclassificado), gravada no envio.
  if (connection) await recordCallResult(connection, ctx, transaction, { ok: false, errorClass: dispatch.lastErrorClass || base.class, probe, now });
  return saida;
}

module.exports = { handleFailure, classifyWithAdapter };
