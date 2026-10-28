'use strict';

const router = require('./campaigns.routes');
const service = require('./campaigns.service');
const lifecycle = require('./lifecycle.service');
const { assertCampaignRunning } = require('./runnerGuard');
const { registerCampaignSendPort } = require('./sendPort');

// Interface pública da área: serviço, ciclo de vida (job), guarda do runner e a porta de envio dos steps (M9-D418/M9-D429).
module.exports = { router, service, lifecycle, assertCampaignRunning, registerCampaignSendPort };
