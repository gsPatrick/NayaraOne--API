'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../../middlewares/auth.middleware');
const tenantMiddleware = require('../../../middlewares/tenant.middleware');
const legalController = require('./legal.controller');
const { deliverKeysForContract } = require('../leasing/deliverKeys.controller');
const guaranteeActionsController = require('../leasing/guaranteeActions.controller');
const legalCasesController = require('../cases/legalCases.controller');
const contractVersionActionsController = require('../contracts/application/contractVersionActions.controller');
const contractTemplateVersionsController = require('../contracts/application/contractTemplateVersions.controller');
const { confirmAction } = require('../../../shared/destructive-actions/guard'); // M9-D852: confirmação com impacto (linha 1 do inventário)

const legalRouter = Router();

// Webhook público do Clicksign — NÃO fica aqui. Bug real encontrado em produção (19/09/2026,
// testado com assinatura de verdade): registrar a rota pública ANTES de
// `legalRouter.use(authMiddleware, ...)` não bastava, porque `routes/index.js` monta VÁRIOS
// routers no mesmo prefixo "/v1" ANTES do legalRouter (groups, companies, units, users,
// memberships, roles, people, properties, crm, radar, finance) — e cada um deles tem seu
// próprio `algumRouter.use(authMiddleware)` SEM path, que intercepta QUALQUER requisição que
// chegue a esse router, não só as rotas dele. Como o Express tenta cada router montado em
// "/v1" em ordem até um responder, o groupsRouter (o primeiro da lista) já rejeitava toda
// chamada ao nosso webhook com 401 antes do legalRouter sequer ser tentado. A rota pública de
// verdade agora está em src/routes/index.js, registrada ANTES de qualquer router com gate de
// autenticação — ver clicksignPublicWebhook em legal.controller.js.
legalRouter.use(authMiddleware, tenantMiddleware);

// Contracts
legalRouter.post('/legal/contracts', requirePermission('legal:create'), legalController.createContract);
legalRouter.get('/legal/contracts', requirePermission('legal:read'), legalController.listContracts);
legalRouter.get('/legal/contracts/:id', requirePermission('legal:read'), legalController.getContract);
legalRouter.post('/legal/contracts/:id/transition', requirePermission('legal:approve'), confirmAction('legal.contract.terminate', { reasonField: 'reason' }), legalController.transitionContract);
// FIX DIVERGÊNCIA (auditoria técnica da cliente, 07/10/2026): fim-de-vida do contrato (Caderno,
// Anexo I "5. Estado do contrato") — SUSPENDED/TERMINATED/CLOSED. Ações HIGH, exigem motivo
// (ver assertReason em contracts.service.js) e permissão de aprovação jurídica, mesmo padrão de
// "/transition" acima (não é correção de dado — é máquina de estados).
legalRouter.post('/legal/contracts/:id/suspend', requirePermission('legal:approve'), legalController.suspendContract);
legalRouter.post('/legal/contracts/:id/reactivate', requirePermission('legal:approve'), legalController.reactivateContract);
legalRouter.post('/legal/contracts/:id/terminate', requirePermission('legal:approve'), confirmAction('legal.contract.terminate', { reasonField: 'reason' }), legalController.terminateContract);
legalRouter.post('/legal/contracts/:id/close', requirePermission('legal:approve'), legalController.closeContract);
legalRouter.post('/legal/contracts/:id/parties', requirePermission('legal:create'), legalController.addContractParty);
legalRouter.get('/legal/contracts/:id/parties', requirePermission('legal:read'), legalController.listContractParties);
legalRouter.get('/legal/contracts/:id/timeline', requirePermission('legal:read'), legalController.getContractTimeline);
// AUD-004: correção auditada de dados já gravados (não é a máquina de estados) — ação HIGH,
// exige MFA recente e motivo obrigatório (ver correctContractData em contracts.service.js).
legalRouter.patch('/legal/contracts/:id/correct', requirePermission('legal:update'), requireRecentMfa, legalController.correctContractData);

// Contract requirements (checklist documental por tipo — Caderno Anexo I "7. Checklist
// documental"). Migration 20260101000291 já aplicada; o gate correspondente roda fail-closed
// de verdade dentro de transitionContractStatus (ver requirements.service.js).
legalRouter.post('/legal/contracts/:id/requirements/generate', requirePermission('legal:create'), legalController.generateContractRequirements);
legalRouter.get('/legal/contracts/:id/requirements', requirePermission('legal:read'), legalController.listContractRequirements);
legalRouter.patch('/legal/requirements/:requirementId', requirePermission('legal:update'), legalController.satisfyContractRequirement);
legalRouter.post('/legal/requirements/:requirementId/waive', requirePermission('legal:waive'), legalController.waiveContractRequirement);

// Notices (notificações formais — Caderno Anexo I "13. Aditivos e notificações"). Migration
// 20260101000292 já aplicada — módulo funcional ponta a ponta.
legalRouter.post('/legal/notices', requirePermission('legal:create'), legalController.createNotice);
legalRouter.get('/legal/notices', requirePermission('legal:read'), legalController.listNotices);
legalRouter.get('/legal/notices/:id', requirePermission('legal:read'), legalController.getNotice);
// DoD M5 "Aditivos/notificações versionados": nova versão preserva a anterior (legal.notice_versions).
legalRouter.post('/legal/notices/:id/versions', requirePermission('legal:update'), legalCasesController.createNoticeVersion);
legalRouter.get('/legal/notices/:id/versions', requirePermission('legal:read'), legalCasesController.listNoticeVersions);
legalRouter.post('/legal/notices/:id/submit-for-review', requirePermission('legal:update'), legalController.submitNoticeForReview);
legalRouter.post('/legal/notices/:id/approve', requirePermission('legal:approve'), legalController.approveNotice);
legalRouter.post('/legal/notices/:id/reject', requirePermission('legal:approve'), legalController.rejectNotice);
// Envio é ação HIGH (notificação formal, pode ter efeito jurídico) — exige MFA recente.
legalRouter.post('/legal/notices/:id/send', requirePermission('legal:update'), requireRecentMfa, legalController.sendNotice);
legalRouter.post('/legal/notices/:id/delivery-evidence', requirePermission('legal:update'), legalController.registerNoticeDeliveryEvidence);

// Contract versions
legalRouter.post('/legal/contracts/:id/versions', requirePermission('legal:create'), legalController.createContractVersion);
// Matriz M5 — rotas literais do Guia §14 (APIs mínimas): mesmo controller, permissão e serviço das rotas /legal/...
legalRouter.post('/contracts', requirePermission('legal:create'), legalController.createContract);
legalRouter.post('/contracts/:id/versions', requirePermission('legal:create'), legalController.createContractVersion);
legalRouter.post('/contract-versions/:id/approve', requirePermission('legal:approve'), contractVersionActionsController.approveContractVersion);
legalRouter.post('/contract-versions/:id/send-signature', requirePermission('legal:sign'), contractVersionActionsController.sendContractVersionForSignature);
legalRouter.get('/legal/contracts/:id/versions', requirePermission('legal:read'), legalController.listContractVersions);
// GET, não POST: sem efeito colateral (nada é persistido) — ver comentário em
// legal.controller.js#generateContractVersionPdf. "legal:read" basta porque é só uma
// representação (PDF) de um documento já existente, não altera o contrato/versão.
legalRouter.get('/legal/contracts/:id/versions/:versionId/generate-pdf', requirePermission('legal:read'), legalController.generateContractVersionPdf);

// Contract templates
legalRouter.post('/legal/contract-templates', requirePermission('legal:create'), legalController.createContractTemplate);
legalRouter.get('/legal/contract-templates', requirePermission('legal:read'), legalController.listContractTemplates);
legalRouter.get('/legal/contract-templates/:id', requirePermission('legal:read'), legalController.getContractTemplate);
legalRouter.post('/legal/contract-templates/:id/clauses', requirePermission('legal:create'), legalController.addClauseToContractTemplate);
legalRouter.post('/legal/contract-templates/:id/clauses/:clauseId/upgrade', requirePermission('legal:create'), legalController.upgradeContractTemplateClause);
// Matriz M5 (§6/§19): publicar a versão do modelo exige a alçada jurídica; publicado não se edita (nova versão).
legalRouter.post('/legal/contract-templates/:id/publish', requirePermission('legal:approve'), contractTemplateVersionsController.publishContractTemplate);
legalRouter.get('/legal/contract-templates/:id/versions', requirePermission('legal:read'), contractTemplateVersionsController.listContractTemplateVersions);
// Biblioteca de cláusulas (JUR-002) — ordem importa: /legal/clauses/:code/versions antes de
// qualquer coisa que capture :id, mesmo padrão já usado para classification-pendings no Marco 4.
legalRouter.post('/legal/clauses', requirePermission('legal:create'), legalController.createClause);
legalRouter.get('/legal/clauses', requirePermission('legal:read'), legalController.listClauses);
legalRouter.get('/legal/clauses/:code/versions', requirePermission('legal:read'), legalController.listClauseVersions);
legalRouter.get('/legal/clauses/:code/template-usage', requirePermission('legal:read'), legalController.listClauseTemplateUsage);
legalRouter.post('/legal/clauses/:code/versions', requirePermission('legal:create'), legalController.createClauseVersion);
legalRouter.post('/legal/clauses/:id/deactivate', requirePermission('legal:update'), legalController.deactivateClause);
// F01: aprovação da regra declarativa de uma versão de cláusula (mesma alçada das transições de contrato).
legalRouter.post('/legal/clauses/:id/approve-condition', requirePermission('legal:approve'), legalController.approveClauseCondition);
// Preview de renderização (só leitura — não persiste nada, ver renderContractTemplate).
legalRouter.post('/legal/contract-templates/:id/render', requirePermission('legal:read'), legalController.renderContractTemplate);

legalRouter.post('/legal/contracts/:id/amendments', requirePermission('legal:create'), legalController.createContractAmendment);
legalRouter.get('/legal/contracts/:id/amendments', requirePermission('legal:read'), legalController.listContractAmendments);
legalRouter.get('/legal/amendments/:id', requirePermission('legal:read'), legalController.getContractAmendment);
legalRouter.post('/legal/amendments/:id/sign', requirePermission('legal:update'), legalController.signContractAmendment);

// Signatures
legalRouter.post('/legal/contract-versions/:id/signatures', requirePermission('legal:sign'), legalController.initiateSignature);
// M45 (Caderno M5 §8): assinatura MANUAL exige arquivo da via assinada e coletor identificado.
legalRouter.post('/legal/signature-envelopes/:id/switch-provider', requirePermission('legal:sign'), requireRecentMfa, legalController.switchSignatureProvider);
legalRouter.post('/legal/contract-versions/:id/manual-signatures', requirePermission('legal:sign'), legalController.recordManualSignature);
legalRouter.get('/legal/contract-versions/:id/signatures', requirePermission('legal:read'), legalController.listSignaturesByContractVersion);
legalRouter.post('/legal/signatures/:externalSignatureId/webhook', requirePermission('legal:sign'), legalController.signatureWebhook);
legalRouter.get('/legal/signatures/:id/status', requirePermission('legal:sign'), legalController.checkSignatureStatus);
legalRouter.post('/legal/signatures/:id/cancel', requirePermission('legal:sign'), legalController.cancelSignature);

// Guarantees
legalRouter.post('/legal/contracts/:contractId/guarantees', requirePermission('legal:create'), legalController.createGuarantee);
legalRouter.get('/legal/guarantees', requirePermission('legal:read'), legalController.listGuarantees);
legalRouter.get('/legal/guarantees/:id', requirePermission('legal:read'), legalController.getGuarantee);
legalRouter.patch('/legal/guarantees/:id', requirePermission('legal:update'), legalController.updateGuarantee);
legalRouter.delete('/legal/guarantees/:id', requirePermission('legal:update'), legalController.removeGuarantee);
// Fechamento M5 (Caderno §9): substituição de garantia pela API, sem perder o histórico.
legalRouter.post('/legal/guarantees/:id/replace', requirePermission('legal:update'), guaranteeActionsController.replaceGuarantee);
legalRouter.get('/legal/guarantee-flows', requirePermission('legal:create'), guaranteeActionsController.listOtherGuaranteeFlows);

// Inspections
legalRouter.post('/legal/inspections', requirePermission('legal:create'), legalController.createInspection);
// FIX (Bug 4, atomicidade): cria vistoria + itens em UMA transação — se qualquer item for
// inválido, nada é gravado (nem a vistoria, nem nenhum item). Ver createInspectionWithItems.
legalRouter.post('/legal/inspections/with-items', requirePermission('legal:create'), legalController.createInspectionWithItems);
legalRouter.get('/legal/inspections', requirePermission('legal:read'), legalController.listInspections);
legalRouter.get('/legal/inspections/compare', requirePermission('legal:read'), legalController.compareInspections);
legalRouter.get('/legal/inspections/:id', requirePermission('legal:read'), legalController.getInspection);
legalRouter.post('/legal/inspections/:id/complete', requirePermission('legal:update'), legalController.completeInspection);
legalRouter.post('/legal/inspections/:id/items', requirePermission('legal:create'), legalController.addInspectionItem);
legalRouter.get('/legal/inspections/:id/items', requirePermission('legal:read'), legalController.listInspectionItems);
legalRouter.post('/legal/inspections/items/:itemId/media', requirePermission('legal:create'), legalController.attachInspectionItemMedia);
legalRouter.get('/legal/inspections/items/:itemId/media', requirePermission('legal:read'), legalController.listInspectionItemMedia);
legalRouter.post('/legal/inspections/:id/sign', requirePermission('legal:update'), requireRecentMfa, legalController.signInspection);
// M45 (Caderno M5 §11/JUR-TS-006): correção de vistoria assinada nasce como revisão.
legalRouter.post('/legal/inspections/:id/revisions', requirePermission('legal:update'), legalController.createInspectionRevision);
legalRouter.get('/legal/inspections/:id/signatures', requirePermission('legal:read'), legalController.listInspectionSignatures);
legalRouter.post('/legal/inspections/:id/report', requirePermission('legal:update'), legalController.generateInspectionReport);
legalRouter.get('/legal/inspections/:id/report', requirePermission('legal:read'), legalController.getInspectionReport);

// Key deliveries — permissão do livro (Guia §11 assertPermission(ctx, 'lease.keys.deliver')), migration 20260101009993.
legalRouter.post('/legal/key-deliveries', requirePermission('legal:create'), legalController.createKeyDelivery);
legalRouter.get('/legal/key-deliveries', requirePermission('legal:read'), legalController.listKeyDeliveries);
legalRouter.get('/legal/key-deliveries/:id', requirePermission('legal:read'), legalController.getKeyDelivery);
legalRouter.get('/legal/key-deliveries/:id/term-preview', requirePermission('legal:read'), legalController.previewKeyDeliveryTerm);
legalRouter.post('/legal/key-deliveries/:id/release', requirePermission('lease.keys.deliver'), legalController.releaseKeyDelivery);
legalRouter.post('/legal/key-deliveries/:id/cancel', requirePermission('lease.keys.deliver'), legalController.cancelKeyDelivery);
// Fechamento M5 (Guia §14 "POST /contracts/:id/key-delivery"): abre e libera na mesma transação, mesmos gates.
legalRouter.post('/legal/contracts/:id/key-delivery', requirePermission('legal:create'), requirePermission('lease.keys.deliver'), deliverKeysForContract);
// Fechamento M5 — rotas literais do Guia §14 da Locação: mesmo controller, permissão, MFA e serviço das rotas /legal/...
legalRouter.post('/contracts/:id/key-delivery', requirePermission('legal:create'), requirePermission('lease.keys.deliver'), deliverKeysForContract);
legalRouter.post('/contracts/:contractId/guarantees', requirePermission('legal:create'), legalController.createGuarantee);
legalRouter.post('/inspections', requirePermission('legal:create'), legalController.createInspection);
legalRouter.post('/inspections/:id/sign', requirePermission('legal:update'), requireRecentMfa, legalController.signInspection);

// Legal cases
legalRouter.post('/legal/cases', requirePermission('legal:create'), legalController.createLegalCase);
legalRouter.get('/legal/cases', requirePermission('legal:read'), legalController.listLegalCases);
legalRouter.get('/legal/cases/:id', requirePermission('legal:read'), legalController.getLegalCase);
legalRouter.patch('/legal/cases/:id', requirePermission('legal:update'), legalController.updateLegalCase);
legalRouter.post('/legal/cases/:id/link-task', requirePermission('legal:update'), legalController.linkCaseToTask);
legalRouter.post('/legal/cases/:id/legal-hold', requirePermission('legal:update'), legalController.setLegalHold);
// Caderno M5 §14: partes formais, documentos/provas por file_links e linha do tempo do processo.
legalRouter.post('/legal/cases/:id/parties', requirePermission('legal:create'), legalCasesController.addLegalCaseParty);
legalRouter.get('/legal/cases/:id/parties', requirePermission('legal:read'), legalCasesController.listLegalCaseParties);
legalRouter.post('/legal/cases/:id/documents', requirePermission('legal:create'), legalCasesController.linkLegalCaseDocument);
legalRouter.get('/legal/cases/:id/documents', requirePermission('legal:read'), legalCasesController.listLegalCaseDocuments);
legalRouter.get('/legal/cases/:id/timeline', requirePermission('legal:read'), legalCasesController.getLegalCaseTimeline);
// §14 "vinculados ao Financeiro somente quando juridicamente cabível": decisão jurídica (legal:approve) + lançamento (finance:create).
legalRouter.post('/legal/cases/:id/receivables', requirePermission('legal:approve'), requirePermission('finance:create'), legalCasesController.linkLegalCaseReceivable);
legalRouter.get('/legal/cases/:id/receivables', requirePermission('legal:read'), legalCasesController.listLegalCaseReceivables);

// Legal deadlines
legalRouter.post('/legal/cases/:id/deadlines', requirePermission('legal:create'), legalController.createLegalDeadline);
legalRouter.get('/legal/deadlines', requirePermission('legal:read'), legalController.listLegalDeadlines);
legalRouter.patch('/legal/deadlines/:id', requirePermission('legal:update'), legalController.updateLegalDeadline);

// Evidence packages
legalRouter.post('/legal/cases/:id/evidence-packages', requirePermission('legal:create'), legalController.createEvidencePackage);
// Guia do Marcelo §14 "POST /legal/cases/:id/evidence-package | Gerar dossiê": a grafia literal do livro (singular) é a mesma rota.
legalRouter.post('/legal/cases/:id/evidence-package', requirePermission('legal:create'), legalController.createEvidencePackage);
// AUD-016 (JUR-010): monta o manifesto automaticamente a partir de todo anexo conhecido do
// contrato — ordem antes de qualquer rota que capture :id solto, mesmo padrão já usado alhures.
legalRouter.post('/legal/cases/:id/evidence-packages/auto', requirePermission('legal:create'), legalController.createEvidencePackageFromContractAttachments);
legalRouter.get('/legal/cases/:id/evidence-packages', requirePermission('legal:read'), legalController.listEvidencePackages);
legalRouter.get('/legal/evidence-packages/:id', requirePermission('legal:read'), legalController.getEvidencePackage);
// M5-28/M5-29: export verificável do dossiê e leitura da cadeia de custódia.
// Caderno M5 §19 "Exportar dossiê | Permissão específica + audit/MFA conforme risco": permissão própria (migration 9999); a DLP continua por cima.
legalRouter.get('/legal/evidence-packages/:id/export', requirePermission('legal:evidence:export'), legalController.exportEvidencePackage);
legalRouter.get('/legal/evidence-packages/:id/access-log', requirePermission('legal:read'), legalController.listEvidencePackageAccessLog);

// NAY Jurídica (Caderno M5 §17, JUR-008, JUR-TS-012): resume, compara e sugere — somente leitura.
// A extração de prazos é POST só porque recebe texto; ela não cria prazo (status PENDING_CONFIRMATION).
legalRouter.get('/legal/nay/contracts/:id/summary', requirePermission('legal:read'), legalController.nayContractSummary);
legalRouter.get('/legal/nay/contracts/:id/compare', requirePermission('legal:read'), legalController.nayContractCompare);
legalRouter.get('/legal/nay/cases/:id/summary', requirePermission('legal:read'), legalController.nayCaseSummary);
legalRouter.get('/legal/nay/cases/:id/dossier', requirePermission('legal:read'), legalController.nayCaseDossier);
legalRouter.get('/legal/nay/clause-suggestions', requirePermission('legal:read'), legalController.nayClauseSuggestions);
legalRouter.post('/legal/nay/deadline-suggestions', requirePermission('legal:read'), legalController.nayDeadlineSuggestions);
// Fechamento M5 (§11): a NAY compara a vistoria de entrada com a de saída e sugere as diferenças; uma pessoa valida cada sugestão.
legalRouter.post('/legal/nay/inspections/compare', requirePermission('legal:read'), legalController.nayInspectionCompare);
// Fechamento M5 (§14): bases jurídicas que a empresa aceita para o recebível do processo (configuração), para a tela oferecer só elas.
legalRouter.get('/legal/receivable-bases', requirePermission('legal:read'), require('../cases/legalCaseReceivableBases.controller').listReceivableBases);

module.exports = legalRouter;
