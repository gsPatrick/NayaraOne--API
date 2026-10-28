'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./automations.controller');

// Rotas 5 a 7 do livro (M9-D435 §3).
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/automations', permission: 'marketing:automation:manage', handler: controller.create },
  { method: 'post', path: '/marketing/automations/:id/publish', permission: 'marketing:automation:publish', handler: controller.publish },
  { method: 'post', path: '/marketing/automations/:id/pause', permission: 'marketing:automation:manage', handler: controller.pause },
]);
