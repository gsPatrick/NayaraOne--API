'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./campaigns.controller');

// Rota 4 do livro (M9-D435 §3).
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/campaigns', permission: 'marketing:campaign:manage', handler: controller.create },
]);
