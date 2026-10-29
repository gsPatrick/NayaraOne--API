'use strict';

const router = require('./suppression.routes');
const service = require('./suppression.service');
const { canSend } = require('./canSend');
const automatic = require('./suppression.automatic');
const { buildCampaignSendPort } = require('./campaignPort');
const { personHash, personHashSalt } = require('./personHash');
const reachable = require('./reachable');
const trackingConsent = require('./trackingConsent');
require('./optOutListener'); // M9-D419: consumidor de customer.opted_out
require('./optOut.screen'); // M9-D419: OPT_OUT registrado em Pessoas passa pelo serviço do opt-out

module.exports = { router, service, canSend, automatic, buildCampaignSendPort, personHash, personHashSalt, reachable, trackingConsent };
