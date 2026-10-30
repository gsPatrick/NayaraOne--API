'use strict';

/**
 * Contexto de log da NAY (M9-D047): todo log da NAY carrega `correlationId` e `runId`. Dentro de um run o contexto guarda o run aberto e o
 * correlationId do pedido; fora dele o correlationId é o da requisição HTTP em curso e o runId fica nulo. O safeLogger lê daqui.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { getCurrentCorrelationId } = require('../../../middlewares/correlationId.middleware');

const storage = new AsyncLocalStorage();

/** Executa `fn` com um contexto próprio ({ runId, correlationId } preenchidos depois por `setRunLog`). */
const runWithLogContext = (fn) => storage.run({ runId: null, correlationId: null }, fn);

/** Registra o run (e o correlationId do pedido) no contexto do run em curso. Fora de um run não faz nada. */
function setRunLog({ runId, correlationId } = {}) {
  const store = storage.getStore();
  if (!store) return;
  if (runId) store.runId = runId;
  if (correlationId) store.correlationId = correlationId;
}

/** { correlationId, runId } do momento; o que não existir é null (a chave sempre está no log). */
function currentLogContext() {
  const store = storage.getStore() || {};
  return { correlationId: store.correlationId || getCurrentCorrelationId() || null, runId: store.runId || null };
}

module.exports = { runWithLogContext, setRunLog, currentLogContext };
