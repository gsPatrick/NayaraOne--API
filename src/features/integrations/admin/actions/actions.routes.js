'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../../middlewares/tenant.middleware');
const controller = require('./actions.controller');

// Ações do operador sobre as integrações (M9-D250): repetir um erro, testar a ligação com o fornecedor e girar a credencial. As leituras são da M9-D249.
// O MFA recente é conferido no serviço (depende da operação: perigosa, ambiente de produção, parâmetro do administrador).
const actionsRouter = Router();
actionsRouter.use(authMiddleware, tenantMiddleware);

actionsRouter.post('/admin/integrations/errors/:id/retry', requirePermission('integration:retry'), controller.retry);
actionsRouter.post('/admin/integrations/:provider/test-connection', requirePermission('integration:test'), controller.test);
actionsRouter.post('/admin/integrations/:provider/rotate-secret', requirePermission('integration:manage'), controller.rotate);

module.exports = actionsRouter;
