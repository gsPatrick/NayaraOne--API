'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const casesController = require('./cases/financingCases.controller');
const documentsController = require('./cases/caseDocuments.controller');
const simulationsController = require('./cases/simulations.controller');
const submissionsController = require('./cases/submissions.controller');
const workflowController = require('./cases/caseWorkflow.controller');
const appraisalsController = require('./cases/appraisals.controller');
const commissionEntitlementsController = require('./cases/commissionEntitlements.controller');
const webhooksController = require('./webhooks.controller');
const nayController = require('./correspondentNay.controller');
const fiscalController = require('./fiscal/fiscal.controller');
const providerAccountsController = require('./providerAccounts.controller');
const parametersController = require('./parameters.controller');
const reviewController = require('./correspondentReview.controller');

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
correspondentRouter.post(
  '/financing-cases/:id/requirements/:requirementId/validate',
  requirePermission('correspondent:create'),
  documentsController.validateRequirement
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

// Workflow manual assistido (provider sem API), cancelamento e proposta do banco. Quem registra o
// resultado ou cancela tem o mesmo nível de quem cria o caso; consultar a proposta é correspondent:read.
correspondentRouter.post(
  '/financing-cases/:id/manual-status',
  requirePermission('correspondent:create'),
  workflowController.registerManualStatus
);
correspondentRouter.post(
  '/financing-cases/:id/cancel',
  requirePermission('correspondent:create'),
  workflowController.cancelCase
);
correspondentRouter.get(
  '/financing-cases/:id/proposals',
  requirePermission('correspondent:read'),
  workflowController.listProposals
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
  '/financing-cases/:id/commissions/:entitlementId/receive',
  requirePermission('correspondent:create'),
  commissionEntitlementsController.receiveCommissionEntitlement
);
correspondentRouter.post(
  '/financing-cases/:id/commissions/:entitlementId/chargeback',
  requirePermission('correspondent:create'),
  commissionEntitlementsController.chargebackCommissionEntitlement
);

// Revisão de possíveis duplicatas, erros de integração e resumo da NAY (lacunas da revisão de 24/10).
correspondentRouter.get('/financing-cases/duplicates/pending', requirePermission('correspondent:read'), reviewController.listPendingDuplicates);
correspondentRouter.post('/financing-cases/:id/duplicate-review', requirePermission('correspondent:create'), reviewController.reviewDuplicate);
correspondentRouter.get('/integration-errors', requirePermission('correspondent:read'), reviewController.listIntegrationErrors);
correspondentRouter.post('/integration-errors/:id/resolve', requirePermission('correspondent:create'), reviewController.resolveIntegrationError);
correspondentRouter.get('/financing-cases/:id/nay/summary', requirePermission('correspondent:read'), nayController.getCaseSummary);

// Parâmetros do correspondente (Motor de Regras): elegibilidade e comissão/split. Ler é
// correspondent:read; publicar nova versão exige a permissão dedicada correspondent:parameters.
correspondentRouter.get('/parameters', requirePermission('correspondent:read'), parametersController.getParameters);
correspondentRouter.put('/parameters/eligibility', requirePermission('correspondent:parameters'), parametersController.updateEligibility);
correspondentRouter.put('/parameters/commission', requirePermission('correspondent:parameters'), parametersController.updateCommission);

// Fase 10 — NAY Correspondente (restrita, somente leitura). Mesmo nível de permissão de leitura
// do caso — a NAY aqui só sinaliza/compara dados já existentes, nunca decide nem altera nada.
correspondentRouter.get(
  '/financing-cases/nay/stalled',
  requirePermission('correspondent:read'),
  nayController.getStalledCases
);
correspondentRouter.get(
  '/financing-cases/:id/nay/compare-simulations',
  requirePermission('correspondent:read'),
  nayController.getCompareSimulations
);

// Fase 12 — Fiscal/Compliance (addendum do Caderno). Permissão própria "correspondent:fiscal"
// (criar/consultar/fechar NFS-e, DIMOB, export contábil e reconciliações) — área sensível,
// separada de "correspondent:create"/"correspondent:read" que são sobre o caso de financiamento
// em si, não sobre o subledger fiscal.
correspondentRouter.post(
  '/fiscal/invoices',
  requirePermission('correspondent:fiscal'),
  fiscalController.requestInvoice
);
correspondentRouter.get(
  '/fiscal/invoices',
  requirePermission('correspondent:fiscal'),
  fiscalController.listInvoiceRequests
);
correspondentRouter.post(
  '/fiscal/invoices/:id/check-status',
  requirePermission('correspondent:fiscal'),
  fiscalController.checkInvoiceStatus
);
correspondentRouter.post(
  '/fiscal/invoices/:id/cancel',
  requirePermission('correspondent:fiscal'),
  fiscalController.cancelInvoice
);
correspondentRouter.get(
  '/fiscal/invoices/:id/events',
  requirePermission('correspondent:fiscal'),
  fiscalController.getInvoiceEvents
);

correspondentRouter.post(
  '/fiscal/dimob-batches',
  requirePermission('correspondent:fiscal'),
  fiscalController.generateDimobBatch
);
correspondentRouter.get(
  '/fiscal/dimob-batches',
  requirePermission('correspondent:fiscal'),
  fiscalController.listDimobBatches
);
correspondentRouter.post(
  '/fiscal/dimob-batches/:id/close',
  requirePermission('correspondent:fiscal'),
  fiscalController.closeDimobBatch
);

correspondentRouter.get(
  '/fiscal/reconciliations',
  requirePermission('correspondent:fiscal'),
  fiscalController.listReconciliations
);
correspondentRouter.post(
  '/fiscal/reconciliations/:id/resolve',
  requirePermission('correspondent:fiscal'),
  fiscalController.resolveReconciliation
);

correspondentRouter.post(
  '/provider-accounts',
  requirePermission('correspondent:create'),
  providerAccountsController.registerProviderAccount
);
correspondentRouter.get(
  '/provider-accounts',
  requirePermission('correspondent:read'),
  providerAccountsController.listProviderAccounts
);

correspondentRouter.post(
  '/fiscal/export-batches',
  requirePermission('correspondent:fiscal'),
  fiscalController.createExportBatch
);
correspondentRouter.get(
  '/fiscal/export-batches',
  requirePermission('correspondent:fiscal'),
  fiscalController.listExportBatches
);

// Conferências, export/retorno contábil, calendário fiscal e arquivos da NFS-e (Marco 8, fiscal).
const fiscalRoutes = [
  ['get', '/fiscal/invoices/:id/xml', 'downloadInvoiceXml'],
  ['get', '/fiscal/invoices/:id/pdf', 'downloadInvoicePdf'],
  ['get', '/fiscal/dimob-batches/:id/records', 'listDimobRecords'],
  ['get', '/fiscal/dimob-batches/:id/file', 'downloadDimobFile'],
  ['post', '/fiscal/reconciliations/run', 'runReconciliations'],
  ['get', '/fiscal/export-candidates', 'listExportCandidates'],
  ['get', '/fiscal/export-batches/:id', 'getExportBatch'],
  ['post', '/fiscal/export-lines/:id/adjust', 'adjustExportLine'],
  ['post', '/fiscal/export-batches/:id/return', 'importAccountingReturn'],
  ['get', '/fiscal/obligations', 'listObligations'],
  ['post', '/fiscal/obligations', 'createObligation'],
  ['post', '/fiscal/obligations/:id/complete', 'completeObligation'],
];
for (const [method, path, handler] of fiscalRoutes) {
  correspondentRouter[method](path, requirePermission('correspondent:fiscal'), fiscalController[handler]);
}

module.exports = correspondentRouter;
