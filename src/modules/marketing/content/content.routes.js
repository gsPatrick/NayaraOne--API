'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./content.controller');

// Rotas 1 a 3 do livro (M9-D435 §3): cada uma com a permissão da tabela de permissões do M9-D402.
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/content', permission: 'marketing:content:write', handler: controller.create },
  { method: 'post', path: '/marketing/content/:id/approve', permission: 'marketing:content:approve', handler: controller.approve },
  { method: 'post', path: '/marketing/content/:id/schedule', permission: 'marketing:content:publish', handler: controller.schedule },
]);
