'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const inventory = require('./inventory');
const { impactHandler } = require('./impact.handler');
require('./providers');

/**
 * Rotas `/impact` das ações do inventário (M9-D852 §3.3) cuja rota de impacto é central (mount = "central"). Não usa `router.use` sem
 * caminho: autenticação, tenant e permissão da ação valem só em cada rota. As rotas de mount "owner" (fila de merge, lote em massa) ficam
 * no módulo dono e devolvem o impactToken pelo mesmo `impactBody`.
 */
const router = Router();
for (const entry of inventory.wired().filter((a) => a.impact.mount === 'central')) {
  router[entry.impact.method.toLowerCase()](entry.impact.path, authMiddleware, tenantMiddleware, requirePermission(entry.permission), impactHandler(entry.key));
}

module.exports = router;
