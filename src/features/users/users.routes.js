'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const usersController = require('./users.controller');
const mfaController = require('./mfa.controller');
const { confirmAction } = require('../../shared/destructive-actions/guard'); // M9-D852 linha 6

const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.post('/users', requirePermission('users:create'), usersController.create);
usersRouter.get('/users', requirePermission('users:read'), usersController.list);
usersRouter.get('/users/:id', requirePermission('users:read'), usersController.getOne);
usersRouter.patch('/users/:id', requirePermission('users:update'), usersController.update);
usersRouter.delete('/users/:id', requirePermission('users:delete'), usersController.remove);
// M9-D852 linha 6: desativar usuário = nível 2 (impacto + "Entendi o impacto") com MFA recente; PATCH /users/:id não muda mais o status para fora de ACTIVE.
usersRouter.patch(
  '/users/:id/deactivate',
  tenantMiddleware,
  requirePermission('users:update'),
  requireRecentMfa,
  confirmAction('user.deactivate'),
  usersController.deactivate
);

// Definir/resetar a senha de outro usuário é ação HIGH (mesmo risco de conceder papel — dá
// acesso efetivo à conta) — exige MFA recente, igual a POST /memberships.
usersRouter.patch(
  '/users/:id/set-password',
  tenantMiddleware,
  requirePermission('users:update'),
  requireRecentMfa,
  usersController.setPassword
);

// MFA (TOTP) próprio — self-service, sem permissão granular dedicada (qualquer usuário
// autenticado pode configurar/desligar o PRÓPRIO MFA). "core.mfa_credentials" tem RLS por
// company_id, então essas rotas precisam de tenantMiddleware (SET LOCAL app.company_id) como
// qualquer outra rota que toque dado multiempresa.
usersRouter.post('/users/me/mfa/setup', tenantMiddleware, mfaController.setup);
usersRouter.post('/users/me/mfa/confirm', tenantMiddleware, mfaController.confirm);
usersRouter.post('/users/me/mfa/verify', tenantMiddleware, mfaController.verify);
usersRouter.post('/users/me/mfa/disable', tenantMiddleware, mfaController.disable);

module.exports = usersRouter;
