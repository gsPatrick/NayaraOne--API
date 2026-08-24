'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const costCentersService = require('./costCenters.service');
const resultCentersService = require('./resultCenters.service');
const bankAccountsService = require('./bankAccounts.service');
const financialEntriesService = require('./financialEntries.service');
const bankTransactionsService = require('./bankTransactions.service');
const reconciliationService = require('./reconciliation.service');
const approvalsService = require('./approvals.service');
const commissionsService = require('./commissions.service');
const ownerRepassesService = require('./ownerRepasses.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

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
const settleFinancialEntry = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => financialEntriesService.settleFinancialEntry(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const reverseFinancialEntry = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    financialEntriesService.reverseFinancialEntry(req.params.id, req.body.reason, req.auth.userId, t)
  );
  return success(res, { data: result });
});

// --- Bank transactions (extrato) ---
const createBankTransaction = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => bankTransactionsService.createBankTransaction(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listBankTransactions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => bankTransactionsService.listBankTransactions(t, { bankAccountId: req.query.bankAccountId }));
  return success(res, { data: items });
});

// --- Reconciliation ---
const matchReconciliation = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => reconciliationService.matchReconciliation(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listReconciliations = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    reconciliationService.listReconciliations(t, { financialEntryId: req.query.financialEntryId, bankTransactionId: req.query.bankTransactionId })
  );
  return success(res, { data: items });
});

// --- Approvals (maker-checker) ---
const createApprovalRequest = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => approvalsService.createApprovalRequest(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listApprovalRequests = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    approvalsService.listApprovalRequests(t, {
      status: req.query.status,
      relatedEntityType: req.query.relatedEntityType,
      relatedEntityId: req.query.relatedEntityId,
    })
  );
  return success(res, { data: items });
});
const decideApprovalStep = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => approvalsService.decideApprovalStep(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Commissions ---
const createCommission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.createCommission(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: result });
});
const listCommissions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    commissionsService.listCommissions(t, { status: req.query.status, beneficiaryUserId: req.query.beneficiaryUserId })
  );
  return success(res, { data: items });
});
const listCommissionInstallments = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => commissionsService.listCommissionInstallments(req.params.id, t));
  return success(res, { data: items });
});
const payCommissionInstallment = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    commissionsService.markInstallmentPaid(req.params.installmentId, req.body.financialEntryId, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Owner repasses ---
const createOwnerRepasse = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => ownerRepassesService.createOwnerRepasse(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listOwnerRepasses = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    ownerRepassesService.listOwnerRepasses(t, { status: req.query.status, ownerPersonId: req.query.ownerPersonId, propertyId: req.query.propertyId })
  );
  return success(res, { data: items });
});
const payOwnerRepasse = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => ownerRepassesService.payOwnerRepasse(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

module.exports = {
  createCostCenter, listCostCenters, updateCostCenter, removeCostCenter,
  createResultCenter, listResultCenters, updateResultCenter, removeResultCenter,
  createBankAccount, listBankAccounts, getBankAccount, updateBankAccount, blockBankAccount, removeBankAccount,
  createFinancialEntry, listFinancialEntries, getFinancialEntry, updateFinancialEntry, settleFinancialEntry, reverseFinancialEntry,
  createBankTransaction, listBankTransactions,
  matchReconciliation, listReconciliations,
  createApprovalRequest, listApprovalRequests, decideApprovalStep,
  createCommission, listCommissions, listCommissionInstallments, payCommissionInstallment,
  createOwnerRepasse, listOwnerRepasses, payOwnerRepasse,
};
