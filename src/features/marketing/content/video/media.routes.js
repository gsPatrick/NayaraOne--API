'use strict';

const { buildMarketingRouter } = require('../../marketing.module');
const controller = require('./media.controller');

// Rota inferida I9 (M9-D435): autorizar a mídia para marketing. Permissão: quem aprova conteúdo (DI-D426-1); o acesso ao arquivo é conferido pelo módulo de arquivos.
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/media/:id/authorize', permission: 'marketing:content:approve', handler: controller.authorize },
]);
