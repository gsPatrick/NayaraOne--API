'use strict';

const { createDispatch } = require('./dispatch.create');

/** Envio de LABORATÓRIO para o ensaio de falha (M9-D226): conteúdo sintético, sem dado de domínio, na connection de laboratório. */
async function createDrillDispatch(ctx, connection, operation, transaction) {
  const { dispatch } = await createDispatch(ctx, {
    connectionId: connection.id, operation, idempotencyKey: `ensaio-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, snapshot: { ensaio: true }, criticalityOp: 'SAFE',
  }, transaction);
  return dispatch;
}

module.exports = { createDrillDispatch };
