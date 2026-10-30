'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./classification.controller');
const { READ_PERMISSION, MANAGE_PERMISSION } = require('./classification.constants');

const DATA_QUALITY = GOVERNANCE_MODULES.find((item) => item.code === 'data-quality');
const MODULE = { ...DATA_QUALITY, prefix: '/data-classification' }; // o liga/desliga do módulo Dados mestres vale também para o registro de classificação

// Registro de classificação (M9-D910): leitura com a permissão dos stewards (governance:data-quality:read); alteração só com governance:classification:manage.
module.exports = buildModuleRouter(MODULE, [
  { method: 'get', path: '/data-classification', permission: READ_PERMISSION, handler: controller.list },
  { method: 'get', path: '/data-classification/legacy-review', permission: READ_PERMISSION, handler: controller.legacyReview },
  { method: 'put', path: '/data-classification', permission: MANAGE_PERMISSION, handler: controller.put },
]);
