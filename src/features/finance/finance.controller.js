'use strict';

const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
const costCentersService = require('./costCenters.service');
const resultCentersService = require('./resultCenters.service');
const bankAccountsService = require('./bankAccounts.service');
const financialEntriesService = require('./financialEntries.service');
const bankTransactionsService = require('./bankTransactions.service');
const reconciliationService = require('./reconciliation.service');
const approvalsService = require('./approvals.service');
const budgetsForecastsService = require('./budgetsForecasts.service');
const { clearManualReview } = require('./financeAntifraud.service');
const commissionsService = require('./commissions.service');
const ownerRepassesService = require('./ownerRepasses.service');
const chartOfAccountsService = require('./chartOfAccounts.service');
const paymentIntentsService = require('./paymentIntents.service');
const anomalyCasesService = require('./anomalyCases.service');
const bankPaymentsService = require('./bankPayments.service');
const intercompanyTransfersService = require('./intercompanyTransfers.service');
const periodClosuresService = require('./periodClosures.service');
const financialHealthReportService = require('./financialHealthReport.service');

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
// GAP REAL CORRIGIDO (ciclo de verificação Marco 4, 12/10/2026): settleFinancialEntryPartial
// (recebimento parcial, FIN-TS-006) existia no service e era testada diretamente, mas nunca
// tinha rota/controller — nenhum humano conseguia dar baixa parcial pela API/tela, só a baixa
// total via settleFinancialEntry.
const settleFinancialEntryPartial = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    financialEntriesService.settleFinancialEntryPartial(req.params.id, req.body.partialAmount, req.auth.userId, t)
  );
  return success(res, { data: item });
});
// GAP REAL CORRIGIDO: fila de pendências de classificação (M4-contrato §10) existia no service,
// sem rota — ninguém via nem resolvia essas pendências.
const listFinancialEntryClassificationPendings = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => financialEntriesService.listClassificationPendings(t, req.query));
  return success(res, { data: items });
});
const resolveFinancialEntryClassificationPending = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    financialEntriesService.resolveClassificationPending(req.params.id, req.body.finalNature, req.auth.userId, t)
  );
  return success(res, { data: item });
});
// GAP REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07, Marco 7): clearManualReview
// (financeAntifraud.service.js) já existia e era usada internamente, mas nunca foi exposta por
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
  const item = await req.withTenantTransaction((t) => bankTransactionsService.createBankTransaction(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listBankTransactions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => bankTransactionsService.listBankTransactions(t, { bankAccountId: req.query.bankAccountId }));
  return success(res, { data: items });
});
const importBankStatement = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => bankTransactionsService.importBankStatement(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: result });
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

// --- Anomaly cases (GAP REAL CORRIGIDO: service completo existia, sem nenhuma rota HTTP —
// toda anomalia detectada ficava invisível pra qualquer humano, só contada no relatório
// semanal como um número solto, sem forma de abrir e ver qual caso é qual) ---
const listAnomalyCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    anomalyCasesService.listAnomalyCases(t, { status: req.query.status, riskLevel: req.query.riskLevel })
  );
  return success(res, { data: items });
});
const resolveAnomalyCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    anomalyCasesService.resolveAnomalyCase(req.params.id, req.auth.userId, t, req.body.resolutionNote)
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

// --- Payment intents (snapshot + hash — M4-07) ---
const createPaymentIntent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => paymentIntentsService.createPaymentIntent(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listPaymentIntents = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    paymentIntentsService.listPaymentIntents(t, { status: req.query.status, financialEntryId: req.query.financialEntryId })
  );
  return success(res, { data: items });
});
const approvePaymentIntent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => paymentIntentsService.approvePaymentIntent(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const executePaymentIntent = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => paymentIntentsService.executePaymentIntent(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});
const cancelPaymentIntent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    paymentIntentsService.cancelPaymentIntent(req.params.id, req.body.reason, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Submissão bancária real (BankAdapter — ver PROVIDER_BANCARIO.md) ---
const submitPaymentIntentToBank = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId };
  const intent = await req.withTenantTransaction((t) =>
    bankPaymentsService.submitPaymentIntentToBank(req.params.id, req.body.paymentMethod, actor, t)
  );
  return success(res, { data: intent });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 38, 2026-10-05): mesma falha de
// segurança já corrigida no webhook de seguro (R37, insurance.controller.js) — HMAC-SHA256 por
// tenant, timing-safe, fail-closed quando há provider real configurado.
const BANK_WEBHOOK_HEADER = 'x-webhook-signature';

function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyBankWebhookSignature(rawBody, headers, webhookSecret) {
  if (!webhookSecret || !rawBody || rawBody.length === 0) return false;
  const received = headers ? headers[BANK_WEBHOOK_HEADER] : null;
  if (!received || typeof received !== 'string') return false;
  const receivedHex = received.startsWith('sha256=') ? received.slice('sha256='.length) : received;

  const expectedHex = computeHmacSha256Hex(webhookSecret, rawBody);

  let expectedBuffer;
  let receivedBuffer;
  try {
    expectedBuffer = Buffer.from(expectedHex, 'hex');
    receivedBuffer = Buffer.from(receivedHex, 'hex');
  } catch (err) {
    return false;
  }
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// Webhook PÚBLICO (fora do authMiddleware/tenantMiddleware — ver finance.routes.js/routes/index.js,
// mesmo padrão de clicksignPublicWebhook em legal.controller.js). O provedor bancário não tem
// (e nunca terá) um JWT de usuário deste sistema.
const bankPaymentPublicWebhook = catchAsync(async (req, res) => {
  const { externalSubmissionId, status } = req.body || {};
  // Valida TIPO, não só presença — um payload malformado (ex.: status como objeto/array) não
  // pode chegar a uma query Sequelize sem passar por aqui primeiro; isso derrubaria o webhook
  // público com um 500 cru, sem nenhum código de erro específico.
  if (typeof externalSubmissionId !== 'string' || !externalSubmissionId || typeof status !== 'string' || !status) {
    return success(res, { statusCode: 400, data: { received: false, reason: 'invalid_payload' } });
  }
  const { sequelize, BankPaymentProviderRouting } = require('../../models');
  const result = await sequelize.transaction(async (t) => {
    // Resolve o tenant via routing table (sem RLS) ANTES de abrir qualquer SET LOCAL — mesma
    // ordem de operações do webhook de assinatura.
    const routing = await BankPaymentProviderRouting.findOne({ where: { externalSubmissionId }, transaction: t });
    if (!routing) {
      // Mesmo padrão do webhook da Clicksign (legal.controller.js): 200 pra o provedor não
      // ficar reenviando infinitamente, mas o motivo de não ter processado fica EXPLÍCITO no
      // campo `reason` da resposta — nunca um "received: true" indistinguível de sucesso real.
      return { received: true, processed: false, reason: 'unknown_routing' };
    }
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: routing.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: routing.companyId }, transaction: t });

    const tenant = { groupId: routing.groupId, companyId: routing.companyId };
    const providerName = await getSetting('finance.payment_provider', tenant, t, 'sandbox');
    if (providerName !== 'sandbox') {
      const webhookSecret = await getDecryptedSetting('finance.bank_payment_webhook_secret', tenant, t, null);
      const isValid = verifyBankWebhookSignature(req.rawBody, req.headers, webhookSecret);
      if (!isValid) {
        throw AppError.unauthorized(
          'Assinatura HMAC do webhook bancário ausente ou inválida para o provedor configurado.',
          'BANK_PAYMENT_WEBHOOK_HMAC_INVALID'
        );
      }
    }

    await bankPaymentsService.confirmBankPayment(externalSubmissionId, status, t);
    return { received: true, processed: true };
  });
  return success(res, { data: result });
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
const reopenPeriod = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => periodClosuresService.reopenPeriod(withTenant(req), req.auth.userId, t));
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

module.exports = {
  createChartAccount, listChartAccounts, updateChartAccount, deactivateChartAccount,
  createPaymentIntent, listPaymentIntents, approvePaymentIntent, executePaymentIntent, cancelPaymentIntent,
  submitPaymentIntentToBank, bankPaymentPublicWebhook, verifyBankWebhookSignature,
  createIntercompanyTransfer, listIntercompanyTransfers, reconcileIntercompanyTransfer,
  closePeriod, reopenPeriod, listPeriodClosures, getWeeklyHealthReport,
  createCostCenter, listCostCenters, updateCostCenter, removeCostCenter,
  createResultCenter, listResultCenters, updateResultCenter, removeResultCenter,
  createBankAccount, listBankAccounts, getBankAccount, updateBankAccount, blockBankAccount, removeBankAccount,
  createFinancialEntry, listFinancialEntries, getFinancialEntry, updateFinancialEntry, settleFinancialEntry, reverseFinancialEntry,
  clearFinancialEntryManualReview, settleFinancialEntryPartial,
  listFinancialEntryClassificationPendings, resolveFinancialEntryClassificationPending,
  createBankTransaction, listBankTransactions, importBankStatement,
  matchReconciliation, listReconciliations, suggestReconciliationMatches, autoReconcileSuggestion,
  createApprovalRequest, listApprovalRequests, decideApprovalStep,
  createCommission, listCommissions, listCommissionInstallments, payCommissionInstallment, cancelCommission, getCommissionAdjustments,
  listAnomalyCases, resolveAnomalyCase,
  createOwnerRepasse, listOwnerRepasses, payOwnerRepasse, getOwnerRepasseComposition,
  createBudgetForecast, listBudgetForecasts, compareBudgetForecastToRealized,
};
