'use strict';

const router = require('./suppression.routes');
const service = require('./suppression.service');
const { canSend } = require('./canSend');
const automatic = require('./suppression.automatic');
const { buildCampaignSendPort } = require('./campaignPort');

module.exports = { router, service, canSend, automatic, buildCampaignSendPort };
