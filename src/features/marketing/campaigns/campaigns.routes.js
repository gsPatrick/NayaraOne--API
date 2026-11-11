'use strict';

const { buildMarketingRouter } = require('../marketing.module');
const controller = require('./campaigns.controller');
const { CAMPAIGN_MANAGE_PERMISSION } = require('./campaigns.constants');

// Rota 4 e I2 do livro (M9-D435): cria/completa/agenda e consulta. Não existe rota de exportação da audiência (Caderno §14).
module.exports = buildMarketingRouter([
  { method: 'post', path: '/marketing/campaigns', permission: CAMPAIGN_MANAGE_PERMISSION, handler: controller.create },
  { method: 'get', path: '/marketing/campaigns/:id', permission: CAMPAIGN_MANAGE_PERMISSION, handler: controller.get },
  // Verificação K=7 (item 5): entregas FAILED por falha transitória voltam à fila, com motivo e auditoria (I14 da D435).
  { method: 'post', path: '/marketing/campaigns/:id/deliveries/reprocess', permission: CAMPAIGN_MANAGE_PERMISSION, handler: controller.reprocess },
]);
