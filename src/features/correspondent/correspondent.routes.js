'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const casesController = require('./cases/financingCases.controller');
const documentsController = require('./cases/caseDocuments.controller');

const correspondentRouter = Router();
correspondentRouter.use(authMiddleware, tenantMiddleware);

correspondentRouter.post('/financing-cases', requirePermission('correspondent:create'), casesController.createFinancingCase);
correspondentRouter.get('/financing-cases', requirePermission('correspondent:read'), casesController.listFinancingCases);
correspondentRouter.get('/financing-cases/:id', requirePermission('correspondent:read'), casesController.getFinancingCase);

// Fase 2 — requirements/documentos. Listar requirements é "correspondent:read" (status do
// checklist é informação de acompanhamento geral); o conteúdo de `documents` (referência ao
// arquivo RESTRICTED) só aparece no payload se o ator também tiver "correspondent:documents:read"
// (checado dentro do controller, não aqui — rota fica aberta ao :read comum, filtro é por dado).
correspondentRouter.post(
  '/financing-cases/:id/requirements',
  requirePermission('correspondent:create'),
  documentsController.createRequirement
);
correspondentRouter.get(
  '/financing-cases/:id/requirements',
  requirePermission('correspondent:read'),
  documentsController.listRequirements
);
// Path "/financing-cases/:id/documents" segue literalmente a lista de "APIs mínimas" do Guia do
// Marcelo (Marco 8) — requirementId vai no corpo, não na URL.
correspondentRouter.post(
  '/financing-cases/:id/documents',
  requirePermission('correspondent:create'),
  documentsController.uploadDocument
);

module.exports = correspondentRouter;
