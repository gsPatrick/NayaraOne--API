'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const casesController = require('./cases/financingCases.controller');
const documentsController = require('./cases/caseDocuments.controller');
const simulationsController = require('./cases/simulations.controller');
const submissionsController = require('./cases/submissions.controller');
const appraisalsController = require('./cases/appraisals.controller');
const commissionEntitlementsController = require('./cases/commissionEntitlements.controller');
const webhooksController = require('./webhooks.controller');

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

// Fase 3 — simulations. Criar exige correspondent:create (mesmo nível de criar o próprio caso);
// listar segue correspondent:read (dado não-restrito, nenhum documento envolvido).
correspondentRouter.post(
  '/financing-cases/:id/simulations',
  requirePermission('correspondent:create'),
  simulationsController.createSimulation
);
correspondentRouter.get(
  '/financing-cases/:id/simulations',
  requirePermission('correspondent:read'),
  simulationsController.listSimulations
);

// Fase 5 — submissão idempotente. Submeter exige correspondent:create (mesmo nível de criar o
// caso); "reconhecer UNKNOWN" (destrava nova tentativa, nunca reenvia cego) também, por ser uma
// ação de mesmo peso de negócio.
correspondentRouter.post(
  '/financing-cases/:id/submissions',
  requirePermission('correspondent:create'),
  submissionsController.submitFinancingCase
);
correspondentRouter.get(
  '/financing-cases/:id/submissions',
  requirePermission('correspondent:read'),
  submissionsController.listSubmissions
);
correspondentRouter.post(
  '/financing-cases/:id/submissions/:submissionId/acknowledge-unknown',
  requirePermission('correspondent:create'),
  submissionsController.acknowledgeUnknownSubmission
);

// Fase 6 — consulta de status consolidado (status atual + histórico append-only). Mesmo nível de
// permissão de leitura do caso.
correspondentRouter.get(
  '/financing-cases/:id/status',
  requirePermission('correspondent:read'),
  webhooksController.getFinancingCaseStatus
);

// Fase 7 — appraisals (avaliação do imóvel). Mesmo nível de permissão de criar/ler o caso —
// avaliação é puramente informativa, não precisa de permissão própria.
correspondentRouter.post(
  '/financing-cases/:id/appraisals',
  requirePermission('correspondent:create'),
  appraisalsController.createAppraisal
);
correspondentRouter.get(
  '/financing-cases/:id/appraisals',
  requirePermission('correspondent:read'),
  appraisalsController.listAppraisals
);

// Fase 8 — comissões (NC). Criar/confirmar/estornar exigem correspondent:create (mesmo nível de
// criar o próprio caso); listar é correspondent:read — valores de comissão não são documento
// RESTRICTED, é informação de acompanhamento do negócio.
correspondentRouter.post(
  '/financing-cases/:id/commissions',
  requirePermission('correspondent:create'),
  commissionEntitlementsController.createCommissionEntitlement
);
correspondentRouter.get(
  '/financing-cases/:id/commissions',
  requirePermission('correspondent:read'),
  commissionEntitlementsController.listCommissionEntitlements
);
correspondentRouter.post(
  '/financing-cases/:id/commissions/:entitlementId/confirm',
  requirePermission('correspondent:create'),
  commissionEntitlementsController.confirmCommissionEntitlement
);
correspondentRouter.post(
  '/financing-cases/:id/commissions/:entitlementId/chargeback',
  requirePermission('correspondent:create'),
  commissionEntitlementsController.chargebackCommissionEntitlement
);

module.exports = correspondentRouter;
