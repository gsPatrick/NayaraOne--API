'use strict';

const { applyTransition } = require('../dispatch.transition');
const { deferDispatch } = require('./worker.defer');
const { reportDispatchError, publishFailed, MENSAGENS } = require('../retry/retry.report');

/**
 * Aplica o veredito de uma verificação feita ANTES da chamada (worker.preflight.js e verificações registradas), sem gastar tentativa:
 *  - { until, reason }: espera (conexão parada, cota, circuito, kill switch) e volta a RETRY_WAIT;
 *  - { unknown: true, reason } (M9-D215): operação perigosa que já tem id externo registrado NUNCA é enviada de novo; vai a UNKNOWN e a
 *    reconciliação consulta o fornecedor pelo id;
 *  - { fail: { class, code, message } } (M9-D239): o conteúdo deixou de valer (aprovação invalidada, versão alterada); o envio fecha em
 *    FAILED com aviso ao domínio, sem nova tentativa.
 * Devolve o resultado que a rodada conta ({ deferred } ou { failed }).
 */
async function applyVerdict(ctx, dispatch, verdict, transaction) {
  if (verdict.unknown) {
    await applyTransition(ctx, dispatch, 'UNKNOWN', { lastErrorClass: 'UNKNOWN', lastErrorCode: String(verdict.reason).slice(0, 64) }, { refundAttempt: true, motivo: 'Operação perigosa com id externo registrado: consultar o fornecedor antes de qualquer repetição.' }, transaction);
    await reportDispatchError(ctx, dispatch, { errorClass: 'UNKNOWN', errorCode: String(verdict.reason).slice(0, 64), severity: 'CRITICAL', message: MENSAGENS.UNKNOWN }, transaction);
    return { deferred: verdict.reason };
  }
  if (verdict.fail) {
    const f = verdict.fail;
    await applyTransition(ctx, dispatch, 'FAILED', { lastErrorClass: f.class || 'VALIDATION', lastErrorCode: String(f.code).slice(0, 64) }, { refundAttempt: true, motivo: f.message || 'Envio fechado antes da chamada.' }, transaction);
    await reportDispatchError(ctx, dispatch, { errorClass: f.class || 'VALIDATION', errorCode: f.code, severity: 'MEDIUM', message: f.message || MENSAGENS.VALIDATION }, transaction);
    await publishFailed(ctx, dispatch, { errorClass: f.class || 'VALIDATION', errorCode: f.code, status: 'FAILED' }, transaction);
    return { failed: { class: f.class || 'VALIDATION', code: f.code } };
  }
  await deferDispatch(ctx, dispatch, verdict.until, verdict.reason, transaction);
  return { deferred: verdict.reason };
}

module.exports = { applyVerdict };
