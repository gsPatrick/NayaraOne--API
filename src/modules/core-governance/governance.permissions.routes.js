'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { tenantFromAuth } = require('./governance.module');
const permissions = require('./governance.permissions');

const router = Router();
router.use('/governance', authMiddleware, tenantMiddleware);

// Catálogo das 21 permissões, a tabela de concessão padrão e as listas de perfis configuradas pelo administrador.
router.get('/governance/permissions', requirePermission('roles:read'), catchAsync(async (req, res) => {
  const lists = await req.withTenantTransaction((transaction) => permissions.readProfileLists(tenantFromAuth(req), transaction));
  return success(res, {
    data: {
      permissoes: permissions.GOVERNANCE_PERMISSIONS,
      concessaoPadrao: permissions.DEFAULT_GRANTS,
      sensiveis: permissions.SENSITIVE_PERMISSIONS,
      perfisConfigurados: lists,
    },
  });
}));

// Aplica a concessão padrão aos perfis da empresa (idempotente; só concede o que falta). Quem edita perfis já tem roles:update.
router.post('/governance/permissions/apply-default', requirePermission('roles:update'), catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((transaction) => permissions.aplicarConcessaoPadrao(tenantFromAuth(req), req.auth.userId, transaction));
  return success(res, { data });
}));

module.exports = router;
