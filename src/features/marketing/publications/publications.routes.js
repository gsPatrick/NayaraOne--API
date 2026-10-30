'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const { confirmAction } = require('../../../shared/destructive-actions/guard');
const { impactHandler } = require('../../../shared/destructive-actions/impact.handler');
const controller = require('./publications.controller');

const CANCEL_ACTION = 'marketing.publication.cancel';

// Rota 8 do livro (M9-D435 §3) e o cancelamento de job (M9-D410). Cancelar é a linha 18 do inventário de ações destrutivas (M9-D852): nível 2, com impacto.
module.exports = buildMarketingRouter([
  { method: 'get', path: '/marketing/publications', permission: 'marketing:content:read', handler: controller.list },
  { method: 'get', path: '/marketing/publications/:id/impact', permission: 'marketing:content:publish', gates: [impactHandler(CANCEL_ACTION)], handler: controller.impactFallback },
  { method: 'post', path: '/marketing/publications/:id/cancel', permission: 'marketing:content:publish', gates: [confirmAction(CANCEL_ACTION, { reasonField: 'reason' })], handler: controller.cancel },
]);
