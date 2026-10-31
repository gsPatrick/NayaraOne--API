'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const controller = require('./migration.controller');
const raciController = require('./raci/raci.controller');
const controlController = require('./control/control.controller');
const parallelController = require('./parallel/parallel.controller');
const { govError } = require('../core-governance/governance.errors');

const RUN_PERMISSION = 'governance:migration:run';
const ADMIN_PERMISSION = 'governance:migration:admin';

/** Mesma checagem de permissão da plataforma, com a mensagem do livro ("Permissão ausente: <código>."). A matriz de permissões (scripts/gerarMatrizPermissoes.js) lê `requiredPermission`. */
function withMessage(permission) {
  const check = requirePermission(permission);
  const middleware = (req, res, next) => check(req, res, (err) => {
    if (err && err.code === 'PERMISSION_DENIED') return next(govError(403, 'PERMISSION_DENIED', `Permissão ausente: ${permission}.`));
    return next(err);
  });
  middleware.requiredPermission = permission;
  return middleware;
}
const requireRunPermission = withMessage(RUN_PERMISSION);
const requireAdminPermission = withMessage(ADMIN_PERMISSION);

/**
 * Rotas da migração v2 (M9-D900 a M9-D905). A operação é por API: sem tela. Os lotes são aplicados e verificados pelo job. Autenticação e tenant valem só sob /migration.
 */
const router = Router();
router.use('/migration', authMiddleware, tenantMiddleware);
router.post('/migration/runs', requireRunPermission, catchAsync(controller.createRun));
router.get('/migration/control-tower', requireRunPermission, catchAsync(controlController.getTower));
router.post('/migration/records/:id/resolve', requireRunPermission, catchAsync(controlController.resolveRecord));
router.get('/migration/raci', requireRunPermission, catchAsync(raciController.getMatrix));
router.put('/migration/raci', requireAdminPermission, catchAsync(raciController.putMatrix));
router.post('/migration/parallel/windows', requireRunPermission, catchAsync(parallelController.createWindow));
router.get('/migration/parallel/windows/:id', requireRunPermission, catchAsync(parallelController.getWindow));

module.exports = router;
