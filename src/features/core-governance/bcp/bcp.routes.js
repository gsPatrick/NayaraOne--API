'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./bcp.controller');
const operations = require('./manualOperation.controller');
const { RECORD_PERMISSION, IMPORT_PERMISSION } = require('./bcp.constants');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'bcp');

// GET /bcp: esqueleto do alicerce (M9-D800), protegido pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/bcp', permission: RECORD_PERMISSION, handler: controller.getOverview },
  // Operações manuais de contingência (M9-D831): registrar e corrigir exigem `bcp:record`; consultar, `bcp:record` ou `bcp:import`. O setor do usuário vem do papel (M9-D830).
  { method: 'post', path: '/bcp/manual-operations', permission: RECORD_PERMISSION, handler: operations.create },
  { method: 'get', path: '/bcp/manual-operations', permission: [RECORD_PERMISSION, IMPORT_PERMISSION], handler: operations.list },
  { method: 'patch', path: '/bcp/manual-operations/:id', permission: RECORD_PERMISSION, handler: operations.update },
]);

module.exports = router;
