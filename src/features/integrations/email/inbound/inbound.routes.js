'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../../middlewares/tenant.middleware');
const controller = require('./inbound.controller');

// E-mail recebido (M9-D235): leitura para quem lê integrações (mensagem com dado pessoal só para quem as administra); o vínculo manual exige administrar.
const inboundRouter = Router();
inboundRouter.use(authMiddleware, tenantMiddleware);
inboundRouter.get('/admin/integrations/email/inbound', requirePermission('integration:read'), controller.list);
inboundRouter.get('/admin/integrations/email/inbound/:id', requirePermission('integration:read'), controller.detail);
inboundRouter.post('/admin/integrations/email/inbound/:id/link', requirePermission('integration:manage'), controller.link);

module.exports = inboundRouter;
