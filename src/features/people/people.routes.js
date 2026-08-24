'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const peopleController = require('./people.controller');

const peopleRouter = Router();

peopleRouter.use(authMiddleware, tenantMiddleware);

peopleRouter.post('/people', requirePermission('people:create'), peopleController.create);
peopleRouter.get('/people', requirePermission('people:read'), peopleController.list);
// Precisa vir ANTES de '/people/:id', senão "duplicates" seria capturado como um :id.
peopleRouter.get('/people/duplicates', requirePermission('people:read'), peopleController.listDuplicates);
peopleRouter.get('/people/:id', requirePermission('people:read'), peopleController.getOne);
peopleRouter.patch('/people/:id', requirePermission('people:update'), peopleController.update);
peopleRouter.delete('/people/:id', requirePermission('people:delete'), peopleController.remove);

peopleRouter.post('/people/:id/contacts', requirePermission('people:update'), peopleController.createContact);
peopleRouter.get('/people/:id/contacts', requirePermission('people:read'), peopleController.listContacts);
peopleRouter.patch('/people/:id/contacts/:contactId', requirePermission('people:update'), peopleController.updateContact);
peopleRouter.delete('/people/:id/contacts/:contactId', requirePermission('people:update'), peopleController.removeContact);

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

module.exports = peopleRouter;
