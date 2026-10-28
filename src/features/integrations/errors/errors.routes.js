'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./errors.controller');

// Fila de erros de integração (M9-D207). A listagem completa/filtros avançados é da M9-D249 e o retry da M9-D250.
const errorsRouter = Router();
errorsRouter.use(authMiddleware, tenantMiddleware);

errorsRouter.get('/admin/integrations/errors', requirePermission('integration:read'), controller.list);
errorsRouter.post('/admin/integrations/errors/:id/resolve', requirePermission('integration:retry'), controller.resolve);

module.exports = errorsRouter;
