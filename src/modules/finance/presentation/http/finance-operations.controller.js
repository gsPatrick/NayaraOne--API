'use strict';

/**
 * Handlers HTTP do Financeiro (Guia M4 §2 presentation/http): comissões, repasses ao proprietário, plano de contas,
 * transferências entre empresas, fechamento de período, relatório de saúde, leitura de insights, orçamento/previsão e regras da Frente 3.
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const budgetsForecastsService = require('../../application/services/budgets-forecasts.service');
const commissionsService = require('../../application/services/commission.service');
const ownerRepassesService = require('../../application/services/owner-repasses.service');
const chartOfAccountsService = require('../../application/services/chart-of-accounts.service');
const intercompanyTransfersService = require('../../application/services/intercompany-transfers.service');
const periodClosuresService = require('../../application/services/closing.service');
const financialHealthReportService = require('../../application/services/finance-health.service');
const financeInsightsService = require('../../application/services/finance-nay.service');
const { withTenant } = require('./finance-request');

// --- Commissions ---
const createCommission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.createCommission(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: result });
});
const listCommissions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    commissionsService.listCommissions(t, {
      status: req.query.status,
      beneficiaryUserId: req.query.beneficiaryUserId,
      includeInstallments: req.query.include === 'installments',
    })
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
const cancelCommission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    commissionsService.cancelCommission(req.params.id, req.body.reason, req.auth.userId, t)
  );
  return success(res, { data: result });
});
// GAP REAL CORRIGIDO: getCommissionAdjustments (histórico de ajustes/cancelamentos de uma
// comissão) existia no service, sem rota — a tela de cancelar comissão não tinha como mostrar
// o histórico de ajustes já feitos.
const getCommissionAdjustments = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => commissionsService.getCommissionAdjustments(req.params.id, t));
  return success(res, { data: items });
});

// --- Owner repasses ---
const createOwnerRepasse = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => ownerRepassesService.createOwnerRepasse(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
// M45 F4: recebimentos elegíveis para o Novo repasse (imóvel/contrato/período).
const listEligibleRepasseSources = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    ownerRepassesService.listEligibleRepasseSources(t, {
      propertyId: req.query.propertyId,
      contractId: req.query.contractId || null,
      referenceMonth: req.query.referenceMonth || null,
    })
  );
  return success(res, { data: items });
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
// GAP REAL CORRIGIDO: getOwnerRepasseComposition (decomposição do valor em aluguel, taxa,
// multa, consumo, manutenção, comissão/administração — Caderno §12 "extrato do proprietário
// mostra composição, não apenas valor líquido") existia no service, sem rota — a tela de
// repasses só mostrava o valor líquido final, violando essa regra explícita.
const getOwnerRepasseComposition = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => ownerRepassesService.getOwnerRepasseComposition(req.params.id, t));
  return success(res, { data: result });
});

// --- Chart of accounts (plano de contas — M4-01) ---
const createChartAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => chartOfAccountsService.createAccount(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listChartAccounts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    chartOfAccountsService.listAccounts(t, {
      parentId: req.query.parentId,
      accountType: req.query.accountType,
      isActive: req.query.isActive,
      asTree: req.query.asTree === 'true',
    })
  );
  return success(res, { data: items });
});
const updateChartAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => chartOfAccountsService.updateAccount(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const deactivateChartAccount = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => chartOfAccountsService.deactivateAccount(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Intercompany transfers (M4-18) ---
const createIntercompanyTransfer = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.createIntercompanyTransfer(withTenant(req), req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: result });
});
const listIntercompanyTransfers = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.listIntercompanyTransfers(t, { status: req.query.status, toCompanyId: req.query.toCompanyId })
  );
  return success(res, { data: items });
});
const reconcileIntercompanyTransfer = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.reconcileIntercompanyTransfer(req.params.id, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Period closures + relatório de saúde financeira (M4-19/M4-20) ---
const closePeriod = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodClosuresService.closePeriod(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const approvePeriodClosure = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodClosuresService.approvePeriodClosure(withTenant(req), req.auth.userId, t));
  return success(res, { data: item });
});
// F02 (2ª rodada) — devolve um pedido de fechamento em REVIEW para OPEN, com motivo.
const returnPeriodToOpen = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodClosuresService.returnPeriodToOpen(withTenant(req), req.auth.userId, t));
  return success(res, { data: item });
});
// F02 — pré-condições do fechamento (Caderno §16) e conferências humanas.
const getPeriodPreconditions = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    periodClosuresService.getPeriodPreconditions({ companyId: req.auth.companyId, referenceMonth: req.params.referenceMonth }, t)
  );
  return success(res, { data: result });
});
const confirmPeriodCheck = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodClosuresService.confirmPeriodCheck(withTenant(req), req.auth.userId, t));
  return success(res, { data: item });
});
const listPeriodClosures = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    periodClosuresService.listPeriodClosures(t, { status: req.query.status, referenceMonth: req.query.referenceMonth })
  );
  return success(res, { data: items });
});
const getWeeklyHealthReport = catchAsync(async (req, res) => {
  const report = await req.withTenantTransaction((t) =>
    financialHealthReportService.getWeeklyHealthReport(t, { companyId: req.auth.companyId })
  );
  return success(res, { data: report });
});

// Caderno M4 §18 — explicações e sugestões somente leitura (finance-nay.service.js).
const getFinanceInsights = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    financeInsightsService.getFinanceInsights({ groupId: req.auth.groupId, companyId: req.auth.companyId }, req.auth.userId, t)
  );
  return success(res, { data });
});

// GAP REAL CORRIGIDO (varredura completa Marco 4, 11/10/2026): finance.budgets_forecasts
// (Caderno §5) tinha service mas nenhuma rota HTTP.
const createBudgetForecast = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => budgetsForecastsService.createBudgetForecast(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listBudgetForecasts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    budgetsForecastsService.listBudgetForecasts(t, {
      competenceMonth: req.query.competenceMonth,
      nature: req.query.nature,
      costCenterId: req.query.costCenterId,
      resultCenterId: req.query.resultCenterId,
    })
  );
  return success(res, { data: items });
});
const compareBudgetForecastToRealized = catchAsync(async (req, res) => {
  const comparison = await req.withTenantTransaction((t) => budgetsForecastsService.compareForecastToRealized(req.query.competenceMonth, t));
  return success(res, { data: comparison });
});

// --- Frente 3 (Regras do Financeiro, Marco 4) ---
const approveIntercompanyTransfer = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.approveIntercompanyTransfer(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: result });
});
const rejectIntercompanyTransfer = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.rejectIntercompanyTransfer(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { data: item });
});
const getGroupConsolidatedReport = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.getGroupConsolidatedReport(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId },
      { referenceMonth: req.query.referenceMonth },
      t
    )
  );
  return success(res, { data: result });
});
const listIntercompanyDestinationAccounts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.listDestinationBankAccounts(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId },
      req.query.toCompanyId,
      t
    )
  );
  return success(res, { data: items });
});
const listIntercompanyDestinationCompanies = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    intercompanyTransfersService.listDestinationCompanies(
      { groupId: req.auth.groupId, companyId: req.auth.companyId, userId: req.auth.userId },
      t
    )
  );
  return success(res, { data: items });
});
const publishCommissionRule = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.publishCommissionRuleVersion(withTenant(req), req.auth.userId, t));
  return success(res, { data: result });
});
const getCommissionRule = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.getActiveCommissionRule(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: result });
});
const listCommissionRuleVersions = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.listCommissionRuleVersions(req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: result });
});
const getCommissionRelease = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => commissionsService.getCommissionRelease(req.params.id, t));
  return success(res, { data: result });
});
const approveOwnerRepasse = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => ownerRepassesService.approveOwnerRepasse(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: result });
});
const listChartAccountVersions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => chartOfAccountsService.listAccountVersions(req.params.id, t));
  return success(res, { data: items });
});

module.exports = {
  createCommission, listCommissions, listCommissionInstallments, payCommissionInstallment, cancelCommission, getCommissionAdjustments, createOwnerRepasse, listEligibleRepasseSources, listOwnerRepasses, payOwnerRepasse, getOwnerRepasseComposition, createChartAccount, listChartAccounts, updateChartAccount, deactivateChartAccount, createIntercompanyTransfer, listIntercompanyTransfers, reconcileIntercompanyTransfer, closePeriod, approvePeriodClosure, returnPeriodToOpen, getPeriodPreconditions, confirmPeriodCheck, listPeriodClosures, getWeeklyHealthReport, getFinanceInsights, createBudgetForecast, listBudgetForecasts, compareBudgetForecastToRealized, approveIntercompanyTransfer, rejectIntercompanyTransfer, getGroupConsolidatedReport, listIntercompanyDestinationAccounts, listIntercompanyDestinationCompanies, publishCommissionRule, getCommissionRule, listCommissionRuleVersions, getCommissionRelease, approveOwnerRepasse, listChartAccountVersions,
};
