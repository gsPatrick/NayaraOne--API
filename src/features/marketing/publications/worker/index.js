'use strict';

/** M9-D411 — worker de publicação do Marketing: ciclo por empresa, parâmetros e a leitura do status real. Fachada da pasta. */
const { runWorkerCycle } = require('./worker.service');
const { WORKER_SETTINGS_SCHEMA, WORKER_SETTING_DEFAULTS, readWorkerParams, backoffFor } = require('./worker.settings');
const { statusKind } = require('./worker.status');
const { ESCALATED_CODE } = require('./worker.escalate');

module.exports = { runWorkerCycle, WORKER_SETTINGS_SCHEMA, WORKER_SETTING_DEFAULTS, readWorkerParams, backoffFor, statusKind, ESCALATED_CODE };
