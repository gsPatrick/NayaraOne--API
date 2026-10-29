'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./contingency.controller');

// APIs administrativas da contingência (M9-D226). A troca para o alternativo aprovada por uma pessoa exige `integration:manage` e MFA recente.
const contingencyRouter = Router();
contingencyRouter.use(authMiddleware, tenantMiddleware);

contingencyRouter.get('/admin/integrations/contingency', requirePermission('integration:read'), controller.list);
contingencyRouter.post('/admin/integrations/contingency/dispatches/:id/switch', requirePermission('integration:manage'), requireRecentMfa, controller.switchDispatch);

module.exports = contingencyRouter;
