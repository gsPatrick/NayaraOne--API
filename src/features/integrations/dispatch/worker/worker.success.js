'use strict';

const { applyTransition } = require('../dispatch.transition');
const { finishAttempt } = require('./worker.attempts');
const { confirmDispatch } = require('./worker.confirm');

/** Resposta de ON_RESPONSE com evidência: operações de consulta (qualquer resposta válida) ou com status final declarado e recurso externo. */
function hasResponseEvidence(def, normalized) {
  if (def.confirmation !== 'ON_RESPONSE') return false;
  if (!def.finalStatuses) return true;
  return Boolean(normalized.externalResourceId) && def.finalStatuses.includes(String(normalized.status).toUpperCase());
}

/**
 * Sucesso do fornecedor (M9-D214 3.2 item 4): grava external_request_id e external_resource_id junto com SUBMITTED na mesma
 * transação (commit) e, só se a política da operação aceitar a resposta como evidência, leva a CONFIRMED.
 */
async function handleSuccess({ ctx, dispatch, def, normalized, attemptId, latencyMs, transaction }) {
  await applyTransition(ctx, dispatch, 'SUBMITTED', {
    externalRequestId: normalized.externalRequestId || undefined, externalResourceId: normalized.externalResourceId || undefined, externalStatus: String(normalized.status).slice(0, 64),
  }, { motivo: 'Fornecedor aceitou o envio.' }, transaction);
  await finishAttempt(attemptId, { outcome: 'SUCCESS', latencyMs }, transaction);
  if (hasResponseEvidence(def, normalized)) {
    await confirmDispatch(ctx, dispatch.id, { source: 'RESPONSE', status: normalized.status, externalResourceId: normalized.externalResourceId }, transaction);
  }
}

module.exports = { handleSuccess, hasResponseEvidence };
