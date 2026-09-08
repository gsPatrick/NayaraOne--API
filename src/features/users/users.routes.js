'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const usersController = require('./users.controller');
const mfaController = require('./mfa.controller');

const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.post('/users', requirePermission('users:create'), usersController.create);
usersRouter.get('/users', requirePermission('users:read'), usersController.list);
usersRouter.get('/users/:id', requirePermission('users:read'), usersController.getOne);
usersRouter.patch('/users/:id', requirePermission('users:update'), usersController.update);
usersRouter.delete('/users/:id', requirePermission('users:delete'), usersController.remove);

// MFA (TOTP) próprio — self-service, sem permissão granular dedicada (qualquer usuário
// autenticado pode configurar/desligar o PRÓPRIO MFA). "core.mfa_credentials" tem RLS por
// company_id, então essas rotas precisam de tenantMiddleware (SET LOCAL app.company_id) como
// qualquer outra rota que toque dado multiempresa.
usersRouter.post('/users/me/mfa/setup', tenantMiddleware, mfaController.setup);
usersRouter.post('/users/me/mfa/confirm', tenantMiddleware, mfaController.confirm);
usersRouter.post('/users/me/mfa/verify', tenantMiddleware, mfaController.verify);
usersRouter.post('/users/me/mfa/disable', tenantMiddleware, mfaController.disable);

module.exports = usersRouter;
