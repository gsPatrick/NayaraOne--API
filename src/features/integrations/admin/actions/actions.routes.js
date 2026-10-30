'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../../middlewares/tenant.middleware');
const controller = require('./actions.controller');
const { confirmAction } = require('../../../../shared/destructive-actions/guard'); // M9-D852 linha 16: só a repetição de operação DANGEROUS pede confirmação

// Ações do operador sobre as integrações (M9-D250): repetir um erro, testar a ligação com o fornecedor e girar a credencial. As leituras são da M9-D249.
// O MFA recente é conferido no serviço (depende da operação: perigosa, ambiente de produção, parâmetro do administrador).
const actionsRouter = Router();
actionsRouter.use(authMiddleware, tenantMiddleware);

actionsRouter.post('/admin/integrations/errors/:id/retry', requirePermission('integration:retry'), confirmAction('integration.error.retry_dangerous', { mfa: true, reasonField: 'reason', extraBody: { confirmDangerous: true } }), controller.retry);
actionsRouter.post('/admin/integrations/:provider/test-connection', requirePermission('integration:test'), controller.test);
actionsRouter.post('/admin/integrations/:provider/rotate-secret', requirePermission('integration:manage'), controller.rotate);

module.exports = actionsRouter;
