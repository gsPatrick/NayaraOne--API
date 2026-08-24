'use strict';

const { Router } = require('express');
const healthController = require('./health.controller');

const healthRouter = Router();
healthRouter.get('/health', healthController.getHealth);

const pingRouter = Router();
pingRouter.get('/ping', healthController.getPing);
pingRouter.get('/health/db', healthController.getDbReadiness);

module.exports = { healthRouter, pingRouter };
