'use strict';

/** Worker de envios a fornecedores (Marco 9, M9-D214). Fachada da API pública. */
const { runDispatchCycle } = require('./worker.cycle');
const { processClaimed } = require('./worker.process');
const { confirmDispatch } = require('./worker.confirm');
const { readWorkerParams, PADROES } = require('./worker.params');
const hooks = require('./worker.hooks');

module.exports = { runDispatchCycle, processClaimed, confirmDispatch, readWorkerParams, PADROES, ...hooks };
