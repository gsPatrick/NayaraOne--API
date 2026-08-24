'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const propertiesController = require('./properties.controller');

const propertiesRouter = Router();

propertiesRouter.use(authMiddleware, tenantMiddleware);

propertiesRouter.post('/properties', requirePermission('properties:create'), propertiesController.create);
propertiesRouter.get('/properties', requirePermission('properties:read'), propertiesController.list);
propertiesRouter.get('/properties/:id', requirePermission('properties:read'), propertiesController.getOne);
propertiesRouter.patch('/properties/:id', requirePermission('properties:update'), propertiesController.update);
propertiesRouter.delete('/properties/:id', requirePermission('properties:delete'), propertiesController.remove);

propertiesRouter.post('/properties/:id/owners', requirePermission('properties:update'), propertiesController.createOwner);
propertiesRouter.get('/properties/:id/owners', requirePermission('properties:read'), propertiesController.listOwners);
propertiesRouter.patch('/properties/:id/owners/:ownerId', requirePermission('properties:update'), propertiesController.updateOwner);
propertiesRouter.delete('/properties/:id/owners/:ownerId', requirePermission('properties:update'), propertiesController.removeOwner);

propertiesRouter.post('/properties/:id/offers', requirePermission('properties:update'), propertiesController.createOffer);
propertiesRouter.get('/properties/:id/offers', requirePermission('properties:read'), propertiesController.listOffers);
propertiesRouter.patch('/properties/:id/offers/:offerId', requirePermission('properties:update'), propertiesController.updateOffer);

// Ocorrências internas — nunca publicáveis; permissão dedicada e distinta de properties:read/update.
propertiesRouter.post('/properties/:id/occurrences', requirePermission('properties:internal'), propertiesController.createOccurrence);
propertiesRouter.get('/properties/:id/occurrences', requirePermission('properties:internal'), propertiesController.listOccurrences);

// Mídia e documentos do imóvel — permissões normais do módulo (properties:read/update), pois
// diferente das ocorrências internas não são conteúdo restrito.
propertiesRouter.post('/properties/:id/media', requirePermission('properties:update'), propertiesController.createMedia);
propertiesRouter.get('/properties/:id/media', requirePermission('properties:read'), propertiesController.listMedia);
propertiesRouter.delete('/properties/:id/media/:mediaId', requirePermission('properties:update'), propertiesController.removeMedia);

propertiesRouter.get('/properties/:id/price-history', requirePermission('properties:read'), propertiesController.listPriceHistory);

propertiesRouter.post('/properties/:id/documents', requirePermission('properties:update'), propertiesController.createDocument);
propertiesRouter.get('/properties/:id/documents', requirePermission('properties:read'), propertiesController.listDocuments);
propertiesRouter.delete('/properties/:id/documents/:documentId', requirePermission('properties:update'), propertiesController.removeDocument);

// Publicação de oferta — REG-IMO-001 (vídeo obrigatório) avaliado via Motor de Regras.
propertiesRouter.post('/offers/:id/publish', requirePermission('properties:update'), propertiesController.publishOffer);

module.exports = propertiesRouter;
