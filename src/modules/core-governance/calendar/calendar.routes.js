'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./calendar.controller');
const commitments = require('./commitments.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'calendar');
const READ = 'governance:calendar:read';

// GET /calendar e compromissos avulsos (origem do tipo COMMITMENT). PATCH, PUT e DELETE em /calendar/items/:id viram 404 padronizado:
// item do calendário é derivado, não editável (M9-D801 §4).
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/calendar', permission: READ, handler: controller.list },
  { method: 'post', path: '/calendar/commitments', permission: READ, handler: commitments.create },
  { method: 'get', path: '/calendar/commitments/:id', permission: READ, handler: commitments.get },
  { method: 'patch', path: '/calendar/commitments/:id', permission: READ, handler: commitments.patch },
  { method: 'patch', path: '/calendar/items/:id', permission: READ, handler: controller.itemNotFound },
  { method: 'put', path: '/calendar/items/:id', permission: READ, handler: controller.itemNotFound },
  { method: 'delete', path: '/calendar/items/:id', permission: READ, handler: controller.itemNotFound },
]);

module.exports = router;
