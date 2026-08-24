'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const rolesController = require('./roles.controller');

const rolesRouter = Router();

rolesRouter.use(authMiddleware, tenantMiddleware);

// Catálogo de permissões (para a tela de administração montar os checkboxes por módulo).
rolesRouter.get('/permissions', requirePermission('roles:read'), rolesController.listPermissions);

rolesRouter.post('/roles', requirePermission('roles:create'), rolesController.create);
rolesRouter.get('/roles', requirePermission('roles:read'), rolesController.list);
rolesRouter.get('/roles/:id', requirePermission('roles:read'), rolesController.getOne);
rolesRouter.patch('/roles/:id', requirePermission('roles:update'), rolesController.update);
rolesRouter.delete('/roles/:id', requirePermission('roles:delete'), rolesController.remove);

module.exports = rolesRouter;
