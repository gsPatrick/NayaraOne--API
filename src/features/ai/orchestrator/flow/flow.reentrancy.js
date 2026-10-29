'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const E = require('./flow.errors');

/**
 * Não reentrante (M9-D020): chamar o orquestrador de dentro de uma tool é proibido (evita loops de agentes e a quebra da allowlist
 * por agente). O escopo vale para tudo que roda dentro de um run, inclusive a execução assíncrona das tools.
 */
const storage = new AsyncLocalStorage();

const isInsideRun = () => storage.getStore() === true;

function assertNotInsideRun() {
  if (isInsideRun()) throw E.reentrant();
}

const runGuarded = (fn) => storage.run(true, fn);

module.exports = { assertNotInsideRun, runGuarded, isInsideRun };
