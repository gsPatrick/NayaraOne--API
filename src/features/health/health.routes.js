'use strict';

const { Router } = require('express');
const healthController = require('./health.controller');

const healthRouter = Router();
healthRouter.get('/health', healthController.getHealth);
// Rodada 8 (DI-M9R-23): saúde do processo para o HEALTHCHECK do contêiner (pool de conexões); 503 reinicia o processo preso.
healthRouter.get('/health/pool', require('./pool.health').getPoolHealth);
healthRouter.get('/version', healthController.getVersion);

const pingRouter = Router();
pingRouter.get('/ping', healthController.getPing);
pingRouter.get('/health/db', healthController.getDbReadiness);

module.exports = { healthRouter, pingRouter };
