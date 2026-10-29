'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./catalog.controller');

// Catálogo das 14 famílias (M9-D201), em `/admin/integrations/catalog`. O caminho `/admin/integrations` é a lista de connections da
// M9-D249 (admin/admin.routes.js) e o registro fica em `/admin/integrations/registry/...`.
const catalogRouter = Router();
catalogRouter.use(authMiddleware, tenantMiddleware);
catalogRouter.get('/admin/integrations/catalog', requirePermission('integration:read'), controller.listIntegrations);

module.exports = catalogRouter;
