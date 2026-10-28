'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./publications.controller');

// Rota 8 do livro (M9-D435 §3).
module.exports = buildMarketingRouter([
  { method: 'get', path: '/marketing/publications', permission: 'marketing:content:read', handler: controller.list },
]);
