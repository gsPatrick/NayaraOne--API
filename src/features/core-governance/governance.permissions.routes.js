'use strict';

const { Router } = require('express');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const { tenantFromAuth } = require('./governance.module');
const permissions = require('./governance.permissions');
const marketingPermissions = require('../marketing/marketing.permissions');
const { ensureOwnerRoles } = require('../analytics/security/ownerRoles.seed');

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
// Também aplica a concessão padrão de Marketing (M9-D402): cria os 3 papéis que faltam e concede o pacote de cada faixa.
// E cria os papéis de owner dos indicadores do BI que faltam (DI-BI2-10), para a empresa criada depois da migration que os semeou.
router.post('/governance/permissions/apply-default', requirePermission('roles:update'), catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction(async (transaction) => ({
    ...(await permissions.aplicarConcessaoPadrao(tenantFromAuth(req), req.auth.userId, transaction)),
    marketing: await marketingPermissions.aplicarConcessaoPadrao(tenantFromAuth(req), req.auth.userId, transaction),
    ownersBi: await ensureOwnerRoles(tenantFromAuth(req), req.auth.userId, transaction),
  }));
  return success(res, { data });
}));

module.exports = router;
