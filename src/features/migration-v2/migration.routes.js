'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const controller = require('./migration.controller');
const { govError } = require('../core-governance/governance.errors');

const RUN_PERMISSION = 'governance:migration:run';
const hasRunPermission = requirePermission(RUN_PERMISSION);

/** Mesma checagem de permissão da plataforma, com a mensagem do livro ("Permissão ausente: governance:migration:run."). */
function requireRunPermission(req, res, next) {
  return hasRunPermission(req, res, (err) => {
    if (err && err.code === 'PERMISSION_DENIED') return next(govError(403, 'PERMISSION_DENIED', `Permissão ausente: ${RUN_PERMISSION}.`));
    return next(err);
  });
}

/**
 * Rotas da migração v2 (M9-D900). A operação é por API: sem tela. Os lotes são aplicados pelo job; o estado deles é lido na Torre de controle (M9-D901).
 * Autenticação e tenant valem só sob /migration.
 */requireRunPermission.requiredPermission = RUN_PERMISSION; // a matriz de permissões (scripts/gerarMatrizPermissoes.js) lê esta marca

const router = Router();
router.use('/migration', authMiddleware, tenantMiddleware);
router.post('/migration/runs', requireRunPermission, catchAsync(controller.createRun));

module.exports = router;
