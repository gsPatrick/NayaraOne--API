'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const peopleController = require('./people.controller');
const personLinksController = require('./personLinks.controller');
const personDedupController = require('./personDedup.controller');

const peopleRouter = Router();

peopleRouter.use(authMiddleware, tenantMiddleware);

peopleRouter.post('/people', requirePermission('people:create'), peopleController.create);
peopleRouter.get('/people', requirePermission('people:read'), peopleController.list);
// Pessoa já cadastrada em outra empresa do grupo: vínculo explícito, com permissão própria (DI-M9I-4). Antes de '/people/:id'.
peopleRouter.post('/people/links', requirePermission('people:link'), personLinksController.link);
// Precisa vir ANTES de '/people/:id', senão "duplicates" seria capturado como um :id.
peopleRouter.get('/people/duplicates', requirePermission('people:read'), peopleController.listDuplicates);
// Consulta de duplicidade ANTES de criar (DI-M3PE-4) e catálogo de papéis da empresa (DI-M3PE-2).
peopleRouter.post('/people/duplicates/check', requirePermission('people:create'), personDedupController.check);
peopleRouter.get('/people/roles-catalog', requirePermission('people:read'), personDedupController.rolesCatalog);
peopleRouter.get('/people/:id', requirePermission('people:read'), peopleController.getOne);
peopleRouter.patch('/people/:id', requirePermission('people:update'), peopleController.update);
peopleRouter.delete('/people/:id', requirePermission('people:delete'), peopleController.remove);

peopleRouter.post('/people/:id/contacts', requirePermission('people:update'), peopleController.createContact);
peopleRouter.get('/people/:id/contacts', requirePermission('people:read'), peopleController.listContacts);
peopleRouter.patch('/people/:id/contacts/:contactId', requirePermission('people:update'), peopleController.updateContact);
peopleRouter.delete('/people/:id/contacts/:contactId', requirePermission('people:update'), peopleController.removeContact);

peopleRouter.post('/people/:id/documents/ingest', requirePermission('people:update'), peopleController.ingestDocument);
peopleRouter.post('/people/:id/documents', requirePermission('people:update'), peopleController.createDocument);
peopleRouter.get('/people/:id/documents', requirePermission('people:read'), peopleController.listDocuments);
peopleRouter.patch('/people/:id/documents/:documentId', requirePermission('people:update'), peopleController.updateDocument);
peopleRouter.delete('/people/:id/documents/:documentId', requirePermission('people:update'), peopleController.removeDocument);

peopleRouter.post('/people/:id/roles', requirePermission('people:update'), peopleController.createRole);
peopleRouter.get('/people/:id/roles', requirePermission('people:read'), peopleController.listRoles);
peopleRouter.patch('/people/:id/roles/:roleId', requirePermission('people:update'), peopleController.updateRole);
peopleRouter.delete('/people/:id/roles/:roleId', requirePermission('people:update'), peopleController.removeRole);

peopleRouter.post('/people/:id/addresses', requirePermission('people:update'), peopleController.createAddress);
peopleRouter.get('/people/:id/addresses', requirePermission('people:read'), peopleController.listAddresses);

peopleRouter.post('/people/:id/consents', requirePermission('people:update'), peopleController.createConsent);
peopleRouter.get('/people/:id/consents', requirePermission('people:read'), peopleController.listConsents);

peopleRouter.post('/people/:id/merge', requirePermission('people:update'), peopleController.merge);
peopleRouter.post('/people/:id/unlink', requirePermission('people:link'), personLinksController.unlink);

module.exports = peopleRouter;
