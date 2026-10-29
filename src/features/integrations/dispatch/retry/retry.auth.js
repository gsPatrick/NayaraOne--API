'use strict';

const logger = require('../../../../utils/logger');
const { transitionConnection } = require('../../registry/connections.transition');
const { applyTransition } = require('../dispatch.transition');
const { storeRenewedCredential } = require('./retry.credential');
const { reportDispatchError, publishFailed, annotateAttempt, MENSAGENS } = require('./retry.report');

const errPatch = (cls, httpStatus) => ({ lastErrorClass: 'AUTH', lastErrorCode: cls.code, lastHttpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined });

/** Tenta renovar a credencial UMA vez por envio; devolve true se a nova versão ficou no cofre. */
async function tryRenew(h) {
  const { ctx, adapter, dispatch, connection, transaction } = h;
  if (!adapter || typeof adapter.renewCredential !== 'function' || dispatch.authRenewals >= 1) return false;
  try {
    const credential = await adapter.renewCredential(adapter.ctx);
    await storeRenewedCredential(ctx, connection.id, credential, transaction);
    return true;
  } catch (err) {
    logger.warn({ connectionId: connection.id, code: err.code }, 'Renovação da credencial falhou; a integração será pausada.');
    return false;
  }
}

/** Segunda recusa, ou adapter sem renovação: connection vai a AUTH_FAILED, o envio fica FAILED (sem loop) e há incidente HIGH. */
async function pauseConnection(h, cls) {
  const { ctx, dispatch, connection, httpStatus, transaction } = h;
  try {
    await transitionConnection(connection.id, 'AUTH_FAILED', ctx, transaction, { system: true });
  } catch (err) {
    if (err.code !== 'INTEGRATION_CONNECTION_INVALID_TRANSITION') throw err; // outra instância já pausou
  }
  await applyTransition(ctx, dispatch, 'FAILED', errPatch(cls, httpStatus), { refundAttempt: true, motivo: 'Credencial recusada: integração pausada, sem nova tentativa.' }, transaction);
  await reportDispatchError(ctx, dispatch, { errorClass: 'AUTH', errorCode: cls.code, severity: 'HIGH', message: MENSAGENS.AUTH, httpStatus }, transaction);
  await publishFailed(ctx, dispatch, { errorClass: 'AUTH', errorCode: cls.code, status: 'FAILED' }, transaction);
  return dispatch;
}

/**
 * AUTH (M9-D216 3.2): se o adapter declara `renewCredential()`, renova UMA vez, grava a nova versão no cofre e repete UMA vez (a
 * tentativa recusada é devolvida: 401 não conta). Segunda falha, ou adapter sem renovação, pausa a connection.
 */
async function applyAuth(h, cls) {
  const { ctx, dispatch, now, httpStatus, transaction } = h;
  await annotateAttempt(h.attemptId, { errorClass: 'AUTH', errorCode: cls.code }, transaction);
  if (await tryRenew(h)) {
    return applyTransition(ctx, dispatch, 'RETRY_WAIT', { ...errPatch(cls, httpStatus), authRenewals: dispatch.authRenewals + 1, nextAttemptAt: now }, { refundAttempt: true, motivo: 'Credencial renovada: uma nova tentativa.' }, transaction);
  }
  return pauseConnection(h, cls);
}

module.exports = { applyAuth };
