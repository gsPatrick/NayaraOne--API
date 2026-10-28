'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./template.controller');
const { TEMPLATE_MANAGE_PERMISSION, CONTENT_READ_PERMISSION } = require('./template.constants');

// Rotas I3 do livro (M9-D435): templates versionados (M9-D404).
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/templates', permission: TEMPLATE_MANAGE_PERMISSION, handler: controller.create },
  { method: 'get', path: '/marketing/templates', permission: CONTENT_READ_PERMISSION, handler: controller.list },
  { method: 'post', path: '/marketing/templates/:id/publish', permission: TEMPLATE_MANAGE_PERMISSION, handler: controller.publish },
]);
