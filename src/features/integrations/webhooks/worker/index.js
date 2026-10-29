'use strict';

/** Worker da caixa de entrada de webhooks (Marco 9, M9-D212). Fachada da API pública. */
const { runIntakeCycle } = require('./worker.cycle');
const { processEvent } = require('./worker.process');
const { PermanentWebhookFailure } = require('./worker.errors');
const { registerDomainHandler, getDomainHandler } = require('./worker.handlers');

module.exports = { runIntakeCycle, processEvent, PermanentWebhookFailure, registerDomainHandler, getDomainHandler };
