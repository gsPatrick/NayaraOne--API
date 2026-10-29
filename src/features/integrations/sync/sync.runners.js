'use strict';

/**
 * Registro dos executores de fluxo (M9-D250): quem é dono de um fluxo de sincronização (`stream`) registra como rodar UM ciclo dele por pedido humano.
 * O retry de um erro SYNC (única saída de um fluxo STALLED, M9-D208) procura aqui o executor do fluxo; sem executor registrado o ciclo não tem como rodar
 * e o retry é recusado. O executor recebe { ctx, connection, stream, origin } (origin HUMAN_RETRY) e devolve o resultado do ciclo ({ status: 'IDLE' | ... }).
 */
const runners = new Map();

function registerSyncRunner(stream, runner) {
  if (typeof stream !== 'string' || !stream || typeof runner !== 'function') throw new Error('registerSyncRunner: informe o fluxo e a função que roda um ciclo.');
  runners.set(stream, runner);
}

const getSyncRunner = (stream) => runners.get(String(stream)) || null;
const unregisterSyncRunner = (stream) => runners.delete(String(stream));

module.exports = { registerSyncRunner, getSyncRunner, unregisterSyncRunner };
