'use strict';

const { router, publicRouter } = require('./tracking.routes');
const service = require('./tracking.service');
require('./tracking.consumers'); // M9-D431: a venda (contract.activated) entra na atribuição

module.exports = { router, publicRouter, service };
