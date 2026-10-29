'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./bcp.controller');
const operations = require('./manualOperation.controller');
const formTemplates = require('./formTemplates.controller');
const importer = require('./import/import.controller');
const { RECORD_PERMISSION, IMPORT_PERMISSION, APPROVE_PERMISSION } = require('./bcp.constants');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'bcp');

// GET /bcp: esqueleto do alicerce (M9-D800), protegido pela permissão do módulo e pelo liga/desliga do administrador.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/bcp', permission: RECORD_PERMISSION, handler: controller.getOverview },
  // Operações manuais de contingência (M9-D831): registrar e corrigir exigem `bcp:record`; consultar, `bcp:record` ou `bcp:import`. O setor do usuário vem do papel (M9-D830).
  { method: 'post', path: '/bcp/manual-operations', permission: RECORD_PERMISSION, handler: operations.create },
  { method: 'get', path: '/bcp/manual-operations', permission: [RECORD_PERMISSION, IMPORT_PERMISSION], handler: operations.list },
  { method: 'patch', path: '/bcp/manual-operations/:id', permission: RECORD_PERMISSION, handler: operations.update },
  // Importação e reconciliação (M9-D832): importar exige `bcp:import`; consultar as reconciliações, `bcp:import` ou `bcp:approve`; decidir a divergência, `bcp:approve`.
  { method: 'post', path: '/bcp/manual-operations/import', permission: IMPORT_PERMISSION, handler: importer.importOperations },
  { method: 'get', path: '/bcp/reconciliations', permission: [IMPORT_PERMISSION, APPROVE_PERMISSION], handler: importer.listReconciliations },
  { method: 'post', path: '/bcp/reconciliations/:id/decide', permission: APPROVE_PERMISSION, handler: importer.decide },
  // Modelos dos formulários contingenciais e sua versão imprimível (M9-D834): leitura de quem registra ou importa e é do setor do modelo.
  { method: 'get', path: '/bcp/form-templates', permission: [RECORD_PERMISSION, IMPORT_PERMISSION], handler: formTemplates.list },
  { method: 'get', path: '/bcp/form-templates/:sector/:formType/print', permission: [RECORD_PERMISSION, IMPORT_PERMISSION], handler: formTemplates.print },
]);

module.exports = router;
