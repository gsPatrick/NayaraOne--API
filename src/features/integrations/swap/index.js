'use strict';

/** Troca de fornecedor sem reescrever o domínio (Marco 9, M9-D221). Fachada da API do módulo. */
const { swapProvider } = require('./swap.service');
const { isDraining, hasOpenDispatches, finishDrains, installSwapDrain } = require('./swap.drain');

module.exports = { swapProvider, isDraining, hasOpenDispatches, finishDrains, installSwapDrain };
