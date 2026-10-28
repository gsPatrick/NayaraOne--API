'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./tracking.controller');

// Rota 9 do livro (M9-D435 §3).
module.exports = buildMarketingRouter([
  { method: 'get', path: '/marketing/attribution', permission: 'marketing:attribution:read', handler: controller.attribution },
]);
