'use strict';

/**
 * Handlers HTTP do Financeiro (Guia M4 §2 presentation/http): aprovações (maker-checker), casos de anomalia,
 * intenções de pagamento, envio ao banco e o webhook público do pagamento bancário.
 */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const AppError = require('../../../../utils/AppError');
const approvalsService = require('../../application/services/approvals.service');
const paymentIntentsService = require('../../application/services/payment.service');
const anomalyCasesService = require('../../application/services/anomaly-cases.service');
const bankPaymentsService = require('../../application/services/bank-submission.service');
const { withTenant, manualSettlementFromBody } = require('./finance-request');

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
  const result = await req.withTenantTransaction((t) => paymentIntentsService.executePaymentIntent(req.params.id, req.auth.userId, t, { manualSettlement: manualSettlementFromBody(req.body) }));
  return success(res, { data: result });
});
const cancelPaymentIntent = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    paymentIntentsService.cancelPaymentIntent(req.params.id, req.body.reason, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// --- Submissão bancária real (BankAdapter — ver PROVIDER_BANCARIO.md) ---
// B1 (revisão independente): 3 fases em transações separadas — SUBMITTING é gravado e
// COMMITADO antes da chamada ao banco; a chamada roda fora de transação; o resultado é gravado
// depois. Uma queda entre o banco e o commit deixa a intenção incerta (SUBMITTING), nunca um
// pagamento no banco sem registro local.
const submitPaymentIntentToBank = catchAsync(async (req, res) => {
  const actor = { userId: req.auth.userId };
  const prepared = await req.withTenantTransaction((t) =>
    bankPaymentsService.prepareBankSubmission(req.params.id, req.body.paymentMethod, actor, t)
  );
  const result = await bankPaymentsService.callBankSubmit(prepared);
  const intent = await req.withTenantTransaction((t) => bankPaymentsService.finalizeBankSubmission(req.params.id, result, actor, t));
  // M9-D237: banco indisponível (circuito aberto, cota ou espera): a ordem foi reagendada no worker, nada foi enviado e a resposta é 503.
  if (result.deferred) throw new AppError(result.error, 503, result.code || 'INTEGRATION_CIRCUIT_OPEN');
  return success(res, { data: intent });
});

// B2 — consulta o banco para uma intenção incerta (o job faz o mesmo periodicamente).
const reconcilePaymentIntent = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => bankPaymentsService.reconcilePaymentIntent(req.params.id, { userId: req.auth.userId }, t));
  if (result.outcome === 'AMOUNT_MISMATCH') throw AppError.conflict('O valor confirmado pelo banco difere do valor aprovado.', result.code); // o erro CRITICAL já foi gravado (commit acima)
  return success(res, { data: result });
});

// B2 — saída controlada (motivo + auditoria); só dá como falha com resposta do banco.
const resolveUncertainPaymentIntent = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    bankPaymentsService.resolveUncertainPaymentIntent(req.params.id, { reason: req.body.reason }, { userId: req.auth.userId }, t)
  );
  return success(res, { data: result });
});

// Webhook e assinatura HMAC do banco: application/services/bank-webhook.service.js (M9-D237).
const { processBankPaymentWebhook: processWebhook, verifyBankWebhookSignature } = require('../../application/services/bank-webhook.service');

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
  const { sequelize } = require('../../../../models');
  const result = await sequelize.transaction((t) =>
    processBankPaymentWebhook({ body: req.body, rawBody: req.rawBody, headers: req.headers }, t)
  );
  // M9-D237: valor diferente do aprovado não confirma; o erro CRITICAL já foi gravado (commit acima) e o banco recebe 409.
  if (result.mismatch) throw AppError.conflict(result.message, result.code);
  return success(res, { data: result });
});

const processBankPaymentWebhook = (input, t) => processWebhook(input, t, { bankPaymentsService: paymentIntentsService });

module.exports = {
  createApprovalRequest, listApprovalRequests, decideApprovalStep, listAnomalyCases, resolveAnomalyCase, createPaymentIntent, listPaymentIntents, approvePaymentIntent, executePaymentIntent, cancelPaymentIntent, submitPaymentIntentToBank, reconcilePaymentIntent, resolveUncertainPaymentIntent, bankPaymentPublicWebhook, processBankPaymentWebhook, verifyBankWebhookSignature,
};
