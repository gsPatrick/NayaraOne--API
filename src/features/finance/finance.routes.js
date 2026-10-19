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
// Rotas estáticas ANTES de /:id — senão Express casa "classification-pendings" como :id.
financeRouter.get('/finance/entries/classification-pendings', requirePermission('finance:read'), financeController.listFinancialEntryClassificationPendings);
financeRouter.post('/finance/entries/classification-pendings/:id/resolve', requirePermission('finance:update'), financeController.resolveFinancialEntryClassificationPending);
financeRouter.get('/finance/entries/:id', requirePermission('finance:read'), financeController.getFinancialEntry);
financeRouter.patch('/finance/entries/:id', requirePermission('finance:update'), financeController.updateFinancialEntry);
// Liquidação de lançamento é step-up MFA obrigatório (Caderno §3.3/3.4: "aprovação de
// pagamento" — liquidar é o ato que efetivamente movimenta o pagamento).
financeRouter.post('/finance/entries/:id/settle', requirePermission('finance:settle'), requireRecentMfa, financeController.settleFinancialEntry);
// A4 (revisão 18/10/2026): comprovante da baixa manual é anexado ANTES da aprovação.
financeRouter.post('/finance/entries/:id/settlement-evidence', requirePermission('finance:settle'), financeController.attachSettlementEvidence);
financeRouter.post('/finance/entries/:id/settlement-evidence/detach', requirePermission('finance:settle'), financeController.detachSettlementEvidence);
financeRouter.post('/finance/entries/:id/reverse', requirePermission('finance:settle'), financeController.reverseFinancialEntry);
financeRouter.post('/finance/entries/:id/clear-manual-review', requirePermission('finance:approve'), requireRecentMfa, financeController.clearFinancialEntryManualReview);
financeRouter.post('/finance/entries/:id/settle-partial', requirePermission('finance:settle'), requireRecentMfa, financeController.settleFinancialEntryPartial);

// Bank transactions (extrato)
financeRouter.post('/finance/bank-transactions', requirePermission('finance:create'), financeController.createBankTransaction);
financeRouter.get('/finance/bank-transactions', requirePermission('finance:read'), financeController.listBankTransactions);
financeRouter.post('/finance/bank-transactions/import', requirePermission('finance:create'), financeController.importBankStatement);

// Reconciliation
financeRouter.post('/finance/reconciliations', requirePermission('finance:reconcile'), financeController.matchReconciliation);
financeRouter.get('/finance/reconciliations', requirePermission('finance:read'), financeController.listReconciliations);
financeRouter.get('/finance/bank-transactions/:id/reconciliation-suggestions', requirePermission('finance:read'), financeController.suggestReconciliationMatches);
financeRouter.post('/finance/bank-transactions/:id/auto-reconcile', requirePermission('finance:update'), financeController.autoReconcileSuggestion);

// Approvals (maker-checker)
financeRouter.post('/finance/approval-requests', requirePermission('finance:create'), financeController.createApprovalRequest);
financeRouter.get('/finance/approval-requests', requirePermission('finance:read'), financeController.listApprovalRequests);
financeRouter.post('/finance/approval-requests/:id/decide', requirePermission('finance:approve'), financeController.decideApprovalStep);

// Commissions
financeRouter.post('/finance/commissions', requirePermission('finance:create'), financeController.createCommission);
financeRouter.get('/finance/commissions', requirePermission('finance:read'), financeController.listCommissions);
financeRouter.get('/finance/commissions/:id/installments', requirePermission('finance:read'), financeController.listCommissionInstallments);
financeRouter.post('/finance/commissions/:id/cancel', requirePermission('finance:update'), financeController.cancelCommission);
financeRouter.get('/finance/commissions/:id/adjustments', requirePermission('finance:read'), financeController.getCommissionAdjustments);
// Frente 3 (§14): regra de comissão no Motor de Regras + liberação proporcional ao recebido.
financeRouter.post('/finance/commission-rule', requirePermission('finance:approve'), requireRecentMfa, financeController.publishCommissionRule);
financeRouter.get('/finance/commission-rule', requirePermission('finance:read'), financeController.getCommissionRule);
financeRouter.get('/finance/commission-rule/versions', requirePermission('finance:read'), financeController.listCommissionRuleVersions);
financeRouter.get('/finance/commissions/:id/release', requirePermission('finance:read'), financeController.getCommissionRelease);

// --- Anomaly cases (antifraude, §17/§19) ---
financeRouter.get('/finance/anomaly-cases', requirePermission('finance:read'), financeController.listAnomalyCases);
financeRouter.post('/finance/anomaly-cases/:id/resolve', requirePermission('finance:update'), financeController.resolveAnomalyCase);
financeRouter.post('/finance/commission-installments/:installmentId/pay', requirePermission('finance:settle'), financeController.payCommissionInstallment);

// Owner repasses
financeRouter.post('/finance/owner-repasses', requirePermission('finance:create'), financeController.createOwnerRepasse);
financeRouter.get('/finance/owner-repasses', requirePermission('finance:read'), financeController.listOwnerRepasses);
financeRouter.get('/finance/owner-repasses/eligible-sources', requirePermission('finance:read'), financeController.listEligibleRepasseSources);
// Frente 3 (§12): aprovação por outra pessoa gera o lançamento a pagar; "pay" confirma o pagamento.
financeRouter.post('/finance/owner-repasses/:id/approve', requirePermission('finance:approve'), requireRecentMfa, financeController.approveOwnerRepasse);
financeRouter.post('/finance/owner-repasses/:id/pay', requirePermission('finance:settle'), financeController.payOwnerRepasse);
financeRouter.get('/finance/owner-repasses/:id/composition', requirePermission('finance:read'), financeController.getOwnerRepasseComposition);

// Chart of accounts (plano de contas — M4-01). Conta nunca é excluída: DELETE aqui desativa.
financeRouter.post('/finance/chart-of-accounts', requirePermission('finance:chartOfAccounts'), financeController.createChartAccount);
financeRouter.get('/finance/chart-of-accounts', requirePermission('finance:read'), financeController.listChartAccounts);
// §4 (Frente 3): histórico de versões; criar/alterar/desativar exige governança (finance:chartOfAccounts).
financeRouter.get('/finance/chart-of-accounts/:id/versions', requirePermission('finance:read'), financeController.listChartAccountVersions);
financeRouter.patch('/finance/chart-of-accounts/:id', requirePermission('finance:chartOfAccounts'), financeController.updateChartAccount);
financeRouter.delete('/finance/chart-of-accounts/:id', requirePermission('finance:chartOfAccounts'), financeController.deactivateChartAccount);

// Payment intents (snapshot + hash dos dados aprovados — M4-07). Aprovar exige a permissão de
// aprovação (maker-checker); executar é o ato que move dinheiro, logo step-up MFA como o settle.
financeRouter.post('/finance/payment-intents', requirePermission('finance:create'), financeController.createPaymentIntent);
financeRouter.get('/finance/payment-intents', requirePermission('finance:read'), financeController.listPaymentIntents);
financeRouter.post('/finance/payment-intents/:id/approve', requirePermission('finance:approve'), financeController.approvePaymentIntent);
financeRouter.post('/finance/payment-intents/:id/execute', requirePermission('finance:settle'), requireRecentMfa, financeController.executePaymentIntent);
financeRouter.post('/finance/payment-intents/:id/cancel', requirePermission('finance:update'), financeController.cancelPaymentIntent);
financeRouter.post('/finance/payment-intents/:id/reconcile', requirePermission('finance:settle'), financeController.reconcilePaymentIntent);
financeRouter.post('/finance/payment-intents/:id/resolve-uncertainty', requirePermission('finance:approve'), requireRecentMfa, financeController.resolveUncertainPaymentIntent);
financeRouter.post('/finance/payment-intents/:id/submit-to-bank', requirePermission('finance:settle'), requireRecentMfa, financeController.submitPaymentIntentToBank);

// Intercompany transfers (M4-18) — criar move dinheiro entre empresas: step-up MFA.
financeRouter.post('/finance/intercompany-transfers', requirePermission('finance:settle'), requireRecentMfa, financeController.createIntercompanyTransfer);
financeRouter.get('/finance/intercompany-transfers', requirePermission('finance:read'), financeController.listIntercompanyTransfers);
// Frente 3 (§15): maker-checker — outra pessoa aprova (cria os dois lados) ou recusa.
financeRouter.post('/finance/intercompany-transfers/:id/approve', requirePermission('finance:approve'), requireRecentMfa, financeController.approveIntercompanyTransfer);
financeRouter.post('/finance/intercompany-transfers/:id/reject', requirePermission('finance:approve'), financeController.rejectIntercompanyTransfer);
financeRouter.get('/finance/intercompany-transfers/destination-bank-accounts', requirePermission('finance:read'), financeController.listIntercompanyDestinationAccounts);
financeRouter.get('/finance/intercompany-transfers/destination-companies', requirePermission('finance:read'), financeController.listIntercompanyDestinationCompanies);
financeRouter.get('/finance/reports/group-consolidated', requirePermission('finance:read'), financeController.getGroupConsolidatedReport);
financeRouter.post('/finance/intercompany-transfers/:id/reconcile', requirePermission('finance:reconcile'), financeController.reconcileIntercompanyTransfer);

// Period closures + saúde financeira (M4-19/M4-20). Reabrir período é ação crítica (permite
// voltar a mexer em mês fechado) — exige a permissão de aprovação, não a de edição comum.
financeRouter.post('/finance/period-closures', requirePermission('finance:settle'), financeController.closePeriod);
// ACHADO REAL CORRIGIDO (auditoria independente Nayara, A06): fechar de verdade (REVIEW→CLOSED)
// é ação sensível, exige aprovação + MFA recente — mesmo padrão de /finance/entries/:id/settle.
financeRouter.post('/finance/period-closures/approve', requirePermission('finance:approve'), requireRecentMfa, financeController.approvePeriodClosure);
financeRouter.get('/finance/period-closures', requirePermission('finance:read'), financeController.listPeriodClosures);
// F02 — pré-condições do fechamento (Caderno §16) e as duas conferências humanas exigidas.
financeRouter.get('/finance/period-closures/:referenceMonth/preconditions', requirePermission('finance:read'), financeController.getPeriodPreconditions);
financeRouter.post('/finance/period-closures/checks', requirePermission('finance:settle'), financeController.confirmPeriodCheck);
financeRouter.post('/finance/period-closures/reopen', requirePermission('finance:approve'), requireRecentMfa, financeController.reopenPeriod);
// F02 (2ª rodada): pedido de fechamento em REVIEW volta para OPEN — mesma alçada da aprovação (finance:approve + MFA recente), motivo obrigatório.
financeRouter.post('/finance/period-closures/return-to-open', requirePermission('finance:approve'), requireRecentMfa, financeController.returnPeriodToOpen);
financeRouter.get('/finance/reports/weekly-health', requirePermission('finance:read'), financeController.getWeeklyHealthReport);
// Caderno M4 §18 (NAY Financeira): explicações/sugestões, só leitura (GET, finance:read).
financeRouter.get('/finance/nay/insights', requirePermission('finance:read'), financeController.getFinanceInsights);

// Budgets/forecasts (M4 — gap fechado na varredura completa, Caderno §5)
financeRouter.post('/finance/budget-forecasts', requirePermission('finance:create'), financeController.createBudgetForecast);
financeRouter.get('/finance/budget-forecasts', requirePermission('finance:read'), financeController.listBudgetForecasts);
financeRouter.get('/finance/budget-forecasts/compare', requirePermission('finance:read'), financeController.compareBudgetForecastToRealized);

module.exports = financeRouter;
