'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const controller = require('./portal.controller');
const { installPortalEvents } = require('./portal.events');

installPortalEvents(); // o consumidor do read model e o tratador do webhook do portal ficam ativos quando o servidor sobe

// Anúncios do imóvel nos portais (M9-D232): publicar e ver o status por portal. Mesma permissão da publicação de oferta (properties:update); leitura com properties:read.
const portalListingsRouter = Router();
portalListingsRouter.use(authMiddleware, tenantMiddleware);

portalListingsRouter.get('/properties/:id/portal-listings', requirePermission('properties:read'), controller.list);
portalListingsRouter.post('/properties/:id/portal-listings/publish', requirePermission('properties:update'), controller.publish);

portalListingsRouter.post('/properties/:id/portal-listings/unpublish', requirePermission('properties:update'), controller.unpublish);

module.exports = portalListingsRouter;
