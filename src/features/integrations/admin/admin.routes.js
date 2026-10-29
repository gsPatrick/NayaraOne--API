'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./admin.controller');

// APIs administrativas de leitura das integrações (M9-D249). A fila de erros fica em errors/errors.routes.js; o catálogo das famílias,
// que ocupava o caminho `/admin/integrations`, passou para `/admin/integrations/catalog` (providers/catalog.routes.js).
const adminRouter = Router();
adminRouter.use(authMiddleware, tenantMiddleware);

adminRouter.get('/admin/integrations', requirePermission('integration:read'), controller.list);
adminRouter.get('/admin/integrations/alerts', requirePermission('integration:read'), controller.alerts);
adminRouter.get('/admin/integrations/dispatches/:id', requirePermission('integration:read'), controller.dispatchDetail);
adminRouter.get('/admin/integrations/:provider/health', requirePermission('integration:read'), controller.health);

module.exports = adminRouter;
