'use strict';

const { buildModuleRouter } = require('../governance.module');
const { GOVERNANCE_MODULES } = require('../governance.settings');
const controller = require('./lineage.controller');

const MODULE = GOVERNANCE_MODULES.find((item) => item.code === 'lineage');
const PERMISSION = 'governance:lineage:manage';

// M9-D810: o registro de lineage (nós e arestas) e a cobertura crítica do grupo. As rotas do livro são /data-lineage/nodes e /data-lineage/edges.
const router = buildModuleRouter(MODULE, [
  { method: 'get', path: '/data-lineage', permission: PERMISSION, handler: controller.getOverview },
  { method: 'post', path: '/data-lineage/nodes', permission: PERMISSION, handler: controller.createNode },
  { method: 'put', path: '/data-lineage/nodes', permission: PERMISSION, handler: controller.putNode },
  { method: 'post', path: '/data-lineage/edges', permission: PERMISSION, handler: controller.createEdge },
  { method: 'put', path: '/data-lineage/edges', permission: PERMISSION, handler: controller.putEdge },
]);

module.exports = router;
