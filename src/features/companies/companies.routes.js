'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const companiesController = require('./companies.controller');

const companiesRouter = Router();

// Correção de segurança: "core"."companies" passou a ter RLS (group_id) — a rota precisa do
// contexto de tenant (SET LOCAL app.group_id/...) resolvido por tenantMiddleware, senão toda
// query fica sem contexto e falha fechada (nenhuma linha visível), quebrando o caso legítimo.
companiesRouter.use(authMiddleware, tenantMiddleware);

companiesRouter.post('/companies', requirePermission('companies:create'), companiesController.create);
companiesRouter.get('/companies', requirePermission('companies:read'), companiesController.list);
companiesRouter.get('/companies/:id', requirePermission('companies:read'), companiesController.getOne);
companiesRouter.patch('/companies/:id', requirePermission('companies:update'), companiesController.update);
companiesRouter.delete('/companies/:id', requirePermission('companies:delete'), companiesController.remove);

module.exports = companiesRouter;
