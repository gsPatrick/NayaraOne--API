'use strict';

/**
 * Handlers HTTP do Financeiro (Guia M4 §2 presentation/http): centros de custo e de resultado, contas bancárias,
 * lançamentos (criação, edição, baixa, estorno, comprovante, pendências de classificação), extrato e conciliação.
 * Os demais handlers estão em finance-payments.controller.js e finance-operations.controller.js; este arquivo
 * expõe o conjunto completo que as rotas usam.
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const costCentersService = require('../../application/services/cost-centers.service');
const resultCentersService = require('../../application/services/result-centers.service');
const bankAccountsService = require('../../application/services/bank-accounts.service');
const financialEntriesService = require('../../application/services/financial-entry.service');
const settlementEvidence = require('../../application/services/settlement-evidence.service');
const receiptService = require('../../application/services/receipt.service');
const classificationPendings = require('../../application/services/classification-pending.service');
const bankTransactionsService = require('../../application/services/bank-transactions.service');
const reconciliationService = require('../../application/services/reconciliation.service');
const reconciliationPolicy = require('../../application/services/reconciliation-policy');
const { clearManualReview } = require('../../application/services/finance-antifraud.service');
const { readClientKey, validateClientKey } = require('../../application/services/settlement-idempotency');
const { withTenant, manualSettlementFromBody } = require('./finance-request');
const paymentsController = require('./finance-payments.controller');
const operationsController = require('./finance-operations.controller');

// --- Cost centers ---
const createCostCenter = catchAsync(async (req, res) => {
  const costCenter = await req.withTenantTransaction((t) => costCentersService.createCostCenter(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: costCenter });
});
const listCostCenters = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => costCentersService.listCostCenters(t));
  return success(res, { data: items });
});
const updateCostCenter = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => costCentersService.updateCostCenter(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const removeCostCenter = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => costCentersService.deleteCostCenter(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Result centers ---
const createResultCenter = catchAsync(async (req, res) => {
  const resultCenter = await req.withTenantTransaction((t) => resultCentersService.createResultCenter(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: resultCenter });
});
const listResultCenters = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => resultCentersService.listResultCenters(t));
  return success(res, { data: items });
});
const updateResultCenter = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => resultCentersService.updateResultCenter(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const removeResultCenter = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => resultCentersService.deleteResultCenter(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Bank accounts ---
const createBankAccount = catchAsync(async (req, res) => {
  const bankAccount = await req.withTenantTransaction((t) => bankAccountsService.createBankAccount(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: bankAccount });
});
const listBankAccounts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => bankAccountsService.listBankAccounts(t, { status: req.query.status, ownerPersonId: req.query.ownerPersonId }));
  return success(res, { data: items });
});
const getBankAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => bankAccountsService.getBankAccount(req.params.id, t));
  return success(res, { data: item });
});
const updateBankAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => bankAccountsService.updateBankAccount(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const blockBankAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => bankAccountsService.blockBankAccount(req.params.id, req.body.reason, req.auth.userId, t));
  return success(res, { data: item });
});
const removeBankAccount = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => bankAccountsService.deleteBankAccount(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Financial entries (ledger / contas a pagar e receber) ---
const createFinancialEntry = catchAsync(async (req, res) => {
  const entry = await req.withTenantTransaction((t) => financialEntriesService.createFinancialEntry(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: entry });
});
const listFinancialEntries = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    financialEntriesService.listFinancialEntries(t, {
      status: req.query.status,
      nature: req.query.nature,
      bankAccountId: req.query.bankAccountId,
      costCenterId: req.query.costCenterId,
      chartOfAccountId: req.query.chartOfAccountId,
      isThirdPartyFunds: req.query.isThirdPartyFunds,
    })
  );
  return success(res, { data: items });
});
const getFinancialEntry = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => financialEntriesService.getFinancialEntry(req.params.id, t));
  return success(res, { data: item });
});
const updateFinancialEntry = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => financialEntriesService.updateFinancialEntry(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
// M45 — remove o vínculo do comprovante de um lançamento em aberto, com motivo.
const detachSettlementEvidence = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    settlementEvidence.detachSettlementEvidence(req.params.id, { reason: req.body && req.body.reason }, req.auth.userId, t)
  );
  return success(res, { data: item });
});
// A4 — comprovante da baixa manual é anexado ANTES da aprovação.
const attachSettlementEvidence = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    settlementEvidence.attachSettlementEvidence(
      req.params.id,
      { evidenceFileId: req.body.settlementEvidenceFileId || req.body.evidenceFileId, reason: req.body.settlementReason || req.body.reason },
      req.auth.userId,
      t
    )
  );
  return success(res, { data: item });
});

const settleFinancialEntry = catchAsync(async (req, res) => {
  const idempotencyKey = validateClientKey(readClientKey(req), { required: false }); // FIN-004: aceita e grava quando vem
  const item = await req.withTenantTransaction((t) => receiptService.settleFinancialEntry(req.params.id, req.auth.userId, t, { manualSettlement: manualSettlementFromBody(req.body), idempotencyKey }));
  return success(res, { data: item });
});
// Baixa parcial (FIN-TS-006) pela API/tela — rota criada no ciclo de verificação do Marco 4 (12/10/2026).
const settleFinancialEntryPartial = catchAsync(async (req, res) => {
  const idempotencyKey = validateClientKey(readClientKey(req), { required: true }); // FIN-004: chave obrigatória na baixa parcial
  const item = await req.withTenantTransaction((t) =>
    receiptService.settleFinancialEntryPartial(req.params.id, req.body.partialAmount, req.auth.userId, t, { manualSettlement: manualSettlementFromBody(req.body), idempotencyKey })
  );
  return success(res, { data: item });
});
// GAP REAL CORRIGIDO: fila de pendências de classificação (M4-contrato §10) existia no service,
// sem rota — ninguém via nem resolvia essas pendências.
const listFinancialEntryClassificationPendings = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => classificationPendings.listClassificationPendings(t, req.query));
  return success(res, { data: items });
});
const resolveFinancialEntryClassificationPending = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    classificationPendings.resolveClassificationPending(req.params.id, req.body.finalNature, req.auth.userId, t, { costCenterId: req.body.costCenterId })
  );
  return success(res, { data: item });
});
// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07, Marco 7): clearManualReview
// (finance-antifraud.service.js) já existia e era usada internamente, mas nunca foi exposta por
// rota nenhuma — um lançamento retido por antifraude não tinha como ser liberado pela API/tela,
// só direto no banco.
const clearFinancialEntryManualReview = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    clearManualReview(req.params.id, req.auth.userId, t, req.body?.reviewNote)
  );
  return success(res, { data: item });
});

// --- Bank transactions (extrato) ---
const createBankTransaction = catchAsync(async (req, res) => {
  // Linha digitada à mão: origem MANUAL, nunca confirmada sozinha pela conciliação (Caderno §11 "auto confirmado se fonte confiável").
  const item = await req.withTenantTransaction((t) => bankTransactionsService.createBankTransaction(withTenant(req), req.auth.userId, t, { source: 'MANUAL' }));
  return success(res, { statusCode: 201, data: item });
});
const listBankTransactions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => bankTransactionsService.listBankTransactions(t, { bankAccountId: req.query.bankAccountId }));
  return success(res, { data: items });
});
const importBankStatement = catchAsync(async (req, res) => {
  // Arquivo importado por quem tem finance:reconcile é fonte confiável para a conciliação automática (DI-M4CC-2); a permissão vem do token.
  const canReconcile = (req.auth.permissions || []).includes('finance:reconcile');
  const result = await req.withTenantTransaction((t) => bankTransactionsService.importBankStatement(withTenant(req), req.auth.userId, t, { canReconcile }));
  return success(res, { statusCode: 201, data: result });
});

// --- Reconciliation ---
const matchReconciliation = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => reconciliationService.matchReconciliation(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
// Conciliação em grupo (N lançamentos x M transações), tolerância zero — Caderno §11 / M4-13.
const matchReconciliationGroup = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => reconciliationService.matchReconciliationGroup(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listReconciliations = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    reconciliationService.listReconciliations(t, { financialEntryId: req.query.financialEntryId, bankTransactionId: req.query.bankTransactionId })
  );
  return success(res, { data: items });
});
// GAP REAL (verificação cética adicional, Marco 4, 12/10/2026): suggestReconciliationMatches —
// o motor de classificação EXATO/FORTE/PROVÁVEL/AMBÍGUO/SEM CORRESPONDÊNCIA exigido pelo
// Caderno (§11) já existia inteiro no service, mas nunca tinha rota — a tela de conciliação
// bypassava a engine inteira e fazia match ingênuo só por valor exato no front. Só sugere,
// nunca executa (ver reconciliation.service.js#suggestReconciliationMatches).
const suggestReconciliationMatches = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    reconciliationService.suggestReconciliationMatches(req.params.id, t)
  );
  return success(res, { data: result });
});
// Regra AUTO_STRONG vigente da empresa (Guia §9): limiares, janela, folga e política, para a tela de conciliação mostrar.
const getReconciliationPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => reconciliationPolicy.readPolicy({ groupId: req.auth.groupId, companyId: req.auth.companyId }, t));
  return success(res, { data: policy });
});
// GAP REAL CORRIGIDO: autoReconcileSuggestion existia no service (confirma EXATO/FORTE e já
// concilia sozinho, igual o Caderno §11 pede — "Exato: auto confirmado"), mas nunca era chamada
// de lugar nenhum, nem pela rota de sugestão nem internamente — morta. Classe AMBÍGUO/PROVÁVEL
// nunca é auto-conciliada por esta rota (ela mesma recusa, ver reconciliation.service.js).
const autoReconcileSuggestion = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    reconciliationService.autoReconcileSuggestion(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, bankTransactionId: req.params.id },
      req.auth.userId,
      t
    )
  );
  return success(res, { data: result });
});

module.exports = {
  createCostCenter, listCostCenters, updateCostCenter, removeCostCenter, createResultCenter, listResultCenters, updateResultCenter, removeResultCenter, createBankAccount, listBankAccounts, getBankAccount, updateBankAccount, blockBankAccount, removeBankAccount, createFinancialEntry, listFinancialEntries, getFinancialEntry, updateFinancialEntry, detachSettlementEvidence, attachSettlementEvidence, settleFinancialEntry, settleFinancialEntryPartial, listFinancialEntryClassificationPendings, resolveFinancialEntryClassificationPending, clearFinancialEntryManualReview, createBankTransaction, listBankTransactions, importBankStatement, matchReconciliation, matchReconciliationGroup, listReconciliations, suggestReconciliationMatches, autoReconcileSuggestion, getReconciliationPolicy,
  ...paymentsController,
  ...operationsController,
};
