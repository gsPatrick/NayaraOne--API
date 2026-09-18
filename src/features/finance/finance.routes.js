'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission, requireRecentMfa } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const financeController = require('./finance.controller');

const financeRouter = Router();

financeRouter.use(authMiddleware, tenantMiddleware);

// Cost centers
financeRouter.post('/finance/cost-centers', requirePermission('finance:create'), financeController.createCostCenter);
financeRouter.get('/finance/cost-centers', requirePermission('finance:read'), financeController.listCostCenters);
financeRouter.patch('/finance/cost-centers/:id', requirePermission('finance:update'), financeController.updateCostCenter);
financeRouter.delete('/finance/cost-centers/:id', requirePermission('finance:update'), financeController.removeCostCenter);

// Result centers
financeRouter.post('/finance/result-centers', requirePermission('finance:create'), financeController.createResultCenter);
financeRouter.get('/finance/result-centers', requirePermission('finance:read'), financeController.listResultCenters);
financeRouter.patch('/finance/result-centers/:id', requirePermission('finance:update'), financeController.updateResultCenter);
financeRouter.delete('/finance/result-centers/:id', requirePermission('finance:update'), financeController.removeResultCenter);

// Bank accounts — criação/edição de dado bancário é sensível (antifraude), permissão dedicada.
financeRouter.post('/finance/bank-accounts', requirePermission('finance:bankAccounts'), financeController.createBankAccount);
financeRouter.get('/finance/bank-accounts', requirePermission('finance:read'), financeController.listBankAccounts);
financeRouter.get('/finance/bank-accounts/:id', requirePermission('finance:read'), financeController.getBankAccount);
// Alteração bancária é step-up MFA obrigatório (Caderno §3.3/3.4), independente de risco.
financeRouter.patch('/finance/bank-accounts/:id', requirePermission('finance:bankAccounts'), requireRecentMfa, financeController.updateBankAccount);
financeRouter.post('/finance/bank-accounts/:id/block', requirePermission('finance:bankAccounts'), financeController.blockBankAccount);
financeRouter.delete('/finance/bank-accounts/:id', requirePermission('finance:bankAccounts'), financeController.removeBankAccount);

// Financial entries (ledger / contas a pagar e receber)
financeRouter.post('/finance/entries', requirePermission('finance:create'), financeController.createFinancialEntry);
financeRouter.get('/finance/entries', requirePermission('finance:read'), financeController.listFinancialEntries);
financeRouter.get('/finance/entries/:id', requirePermission('finance:read'), financeController.getFinancialEntry);
financeRouter.patch('/finance/entries/:id', requirePermission('finance:update'), financeController.updateFinancialEntry);
// Liquidação de lançamento é step-up MFA obrigatório (Caderno §3.3/3.4: "aprovação de
// pagamento" — liquidar é o ato que efetivamente movimenta o pagamento).
financeRouter.post('/finance/entries/:id/settle', requirePermission('finance:settle'), requireRecentMfa, financeController.settleFinancialEntry);
financeRouter.post('/finance/entries/:id/reverse', requirePermission('finance:settle'), financeController.reverseFinancialEntry);

// Bank transactions (extrato)
financeRouter.post('/finance/bank-transactions', requirePermission('finance:create'), financeController.createBankTransaction);
financeRouter.get('/finance/bank-transactions', requirePermission('finance:read'), financeController.listBankTransactions);

// Reconciliation
financeRouter.post('/finance/reconciliations', requirePermission('finance:reconcile'), financeController.matchReconciliation);
financeRouter.get('/finance/reconciliations', requirePermission('finance:read'), financeController.listReconciliations);

// Approvals (maker-checker)
financeRouter.post('/finance/approval-requests', requirePermission('finance:create'), financeController.createApprovalRequest);
financeRouter.get('/finance/approval-requests', requirePermission('finance:read'), financeController.listApprovalRequests);
financeRouter.post('/finance/approval-requests/:id/decide', requirePermission('finance:approve'), financeController.decideApprovalStep);

// Commissions
financeRouter.post('/finance/commissions', requirePermission('finance:create'), financeController.createCommission);
financeRouter.get('/finance/commissions', requirePermission('finance:read'), financeController.listCommissions);
financeRouter.get('/finance/commissions/:id/installments', requirePermission('finance:read'), financeController.listCommissionInstallments);
financeRouter.post('/finance/commission-installments/:installmentId/pay', requirePermission('finance:settle'), financeController.payCommissionInstallment);

// Owner repasses
financeRouter.post('/finance/owner-repasses', requirePermission('finance:create'), financeController.createOwnerRepasse);
financeRouter.get('/finance/owner-repasses', requirePermission('finance:read'), financeController.listOwnerRepasses);
financeRouter.post('/finance/owner-repasses/:id/pay', requirePermission('finance:settle'), financeController.payOwnerRepasse);

// Chart of accounts (plano de contas — M4-01). Conta nunca é excluída: DELETE aqui desativa.
financeRouter.post('/finance/chart-of-accounts', requirePermission('finance:create'), financeController.createChartAccount);
financeRouter.get('/finance/chart-of-accounts', requirePermission('finance:read'), financeController.listChartAccounts);
financeRouter.patch('/finance/chart-of-accounts/:id', requirePermission('finance:update'), financeController.updateChartAccount);
financeRouter.delete('/finance/chart-of-accounts/:id', requirePermission('finance:update'), financeController.deactivateChartAccount);

// Payment intents (snapshot + hash dos dados aprovados — M4-07). Aprovar exige a permissão de
// aprovação (maker-checker); executar é o ato que move dinheiro, logo step-up MFA como o settle.
financeRouter.post('/finance/payment-intents', requirePermission('finance:create'), financeController.createPaymentIntent);
financeRouter.get('/finance/payment-intents', requirePermission('finance:read'), financeController.listPaymentIntents);
financeRouter.post('/finance/payment-intents/:id/approve', requirePermission('finance:approve'), financeController.approvePaymentIntent);
financeRouter.post('/finance/payment-intents/:id/execute', requirePermission('finance:settle'), requireRecentMfa, financeController.executePaymentIntent);
financeRouter.post('/finance/payment-intents/:id/cancel', requirePermission('finance:update'), financeController.cancelPaymentIntent);

// Intercompany transfers (M4-18) — criar move dinheiro entre empresas: step-up MFA.
financeRouter.post('/finance/intercompany-transfers', requirePermission('finance:settle'), requireRecentMfa, financeController.createIntercompanyTransfer);
financeRouter.get('/finance/intercompany-transfers', requirePermission('finance:read'), financeController.listIntercompanyTransfers);
financeRouter.post('/finance/intercompany-transfers/:id/reconcile', requirePermission('finance:reconcile'), financeController.reconcileIntercompanyTransfer);

// Period closures + saúde financeira (M4-19/M4-20). Reabrir período é ação crítica (permite
// voltar a mexer em mês fechado) — exige a permissão de aprovação, não a de edição comum.
financeRouter.post('/finance/period-closures', requirePermission('finance:settle'), financeController.closePeriod);
financeRouter.get('/finance/period-closures', requirePermission('finance:read'), financeController.listPeriodClosures);
financeRouter.post('/finance/period-closures/reopen', requirePermission('finance:approve'), financeController.reopenPeriod);
financeRouter.get('/finance/reports/weekly-health', requirePermission('finance:read'), financeController.getWeeklyHealthReport);

module.exports = financeRouter;
