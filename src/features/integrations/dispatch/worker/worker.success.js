'use strict';

const { applyTransition } = require('../dispatch.transition');
const { finishAttempt } = require('./worker.attempts');
const { confirmDispatch } = require('./worker.confirm');
const { classifyExternalStatus } = require('../reconcile/reconcile.outcome');

/** Resposta de ON_RESPONSE com evidência: operações de consulta (qualquer resposta válida) ou com status final declarado e recurso externo. */
function hasResponseEvidence(def, normalized) {
  if (def.confirmation !== 'ON_RESPONSE') return false;
  if (!def.finalStatuses) return true;
  return Boolean(normalized.externalResourceId) && def.finalStatuses.includes(String(normalized.status).toUpperCase());
}

/** Rede sem consulta de status (M9-D239 3.1): a resposta com o id do recurso e status final de sucesso confirma. */
const confirmsByResponseId = (adapter, dispatch, normalized) => Boolean(adapter && adapter.confirmsOnResponse(dispatch.operation))
  && Boolean(normalized.externalResourceId) && classifyExternalStatus(normalized.status) === 'CONFIRMED';

/**
 * Sucesso do fornecedor (M9-D214 3.2 item 4): grava external_request_id e external_resource_id junto com SUBMITTED na mesma
 * transação (commit) e, só se a política da operação aceitar a resposta como evidência, leva a CONFIRMED.
 */
async function handleSuccess({ ctx, dispatch, def, adapter, normalized, attemptId, latencyMs, transaction }) {
  await applyTransition(ctx, dispatch, 'SUBMITTED', {
    externalRequestId: normalized.externalRequestId || undefined, externalResourceId: normalized.externalResourceId || undefined, externalStatus: String(normalized.status).slice(0, 64),
  }, { motivo: 'Fornecedor aceitou o envio.' }, transaction);
  await finishAttempt(attemptId, { outcome: 'SUCCESS', latencyMs }, transaction);
  if (hasResponseEvidence(def, normalized)) {
    await confirmDispatch(ctx, dispatch.id, { source: 'RESPONSE', status: normalized.status, externalResourceId: normalized.externalResourceId }, transaction);
  } else if (confirmsByResponseId(adapter, dispatch, normalized)) {
    await confirmDispatch(ctx, dispatch.id, { source: 'RESPONSE_ID', status: normalized.status, externalResourceId: normalized.externalResourceId }, transaction);
  }
}

module.exports = { handleSuccess, hasResponseEvidence };
