'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./catalog.controller');

// Catálogo das 14 famílias (M9-D201). Só o caminho exato `/admin/integrations`; as listagens por fornecedor
// (`/admin/integrations/:provider/...`) são da M9-D249 e o registro fica em `/admin/integrations/registry/...`.
const catalogRouter = Router();
catalogRouter.use(authMiddleware, tenantMiddleware);
catalogRouter.get('/admin/integrations', requirePermission('integration:read'), controller.listIntegrations);

module.exports = catalogRouter;
