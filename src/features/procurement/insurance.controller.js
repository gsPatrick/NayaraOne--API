'use strict';

const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
const service = require('./insurance.service');

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 37, 2026-10-05): insurancePublicWebhook
// nunca validava assinatura nenhuma — qualquer requisição que conhecesse (ou adivinhasse) o
// externalSubmissionId conseguia forjar liquidação de sinistro e criar um lançamento financeiro
// real (CREDIT/RECEIVABLE) com valor arbitrário. Mesmo esquema HMAC-SHA256 já usado pro webhook
// do Clicksign (legal.controller.js#verifyProviderWebhookSignature) — secret por tenant,
// comparação com crypto.timingSafeEqual (nunca `===`, que vazaria timing).
const INSURANCE_WEBHOOK_HEADER = 'x-webhook-signature';

function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyInsuranceWebhookSignature(rawBody, headers, webhookSecret) {
  if (!webhookSecret || !rawBody || rawBody.length === 0) return false;
  const received = headers ? headers[INSURANCE_WEBHOOK_HEADER] : null;
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

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.createPolicy(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: policy });
});

const listPolicies = catchAsync(async (req, res) => {
  const policies = await req.withTenantTransaction((t) => service.listPolicies({ status: req.query.status, propertyId: req.query.propertyId }, t));
  return success(res, { data: policies });
});

const getPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.getPolicy(req.params.id, t));
  return success(res, { data: policy });
});

const quotePolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.quotePolicy(req.params.id, req.body, { userId: req.auth.userId }, t));
  return success(res, { data: policy });
});

const issuePolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.issuePolicy(req.params.id, req.body, { userId: req.auth.userId }, t));
  return success(res, { data: policy });
});

const openClaim = catchAsync(async (req, res) => {
  const claim = await req.withTenantTransaction((t) => service.openClaim(req.params.id, req.body, { userId: req.auth.userId }, t));
  return success(res, { statusCode: 201, data: claim });
});

const submitClaim = catchAsync(async (req, res) => {
  const claim = await req.withTenantTransaction((t) => service.submitClaim(req.params.id, { userId: req.auth.userId }, t));
  return success(res, { data: claim });
});

const attachPolicyDocument = catchAsync(async (req, res) => {
  const link = await req.withTenantTransaction((t) =>
    service.attachPolicyDocument(req.params.id, req.body.fileId, { userId: req.auth.userId }, t)
  );
  return success(res, { statusCode: 201, data: link });
});

const listPolicyDocuments = catchAsync(async (req, res) => {
  const links = await req.withTenantTransaction((t) => service.listPolicyDocuments(req.params.id, t));
  return success(res, { data: links });
});

const listPolicyInstallments = catchAsync(async (req, res) => {
  const installments = await req.withTenantTransaction((t) => service.listPolicyInstallments(req.params.id, t));
  return success(res, { data: installments });
});

const payPolicyInstallment = catchAsync(async (req, res) => {
  const installment = await req.withTenantTransaction((t) =>
    service.payInsurancePolicyInstallment(req.params.installmentId, req.body.financialEntryId, { userId: req.auth.userId }, t)
  );
  return success(res, { data: installment });
});

// Webhook público da seguradora — SEM authMiddleware/tenantMiddleware (ver routes/index.js),
// resolve tenant via InsuranceProviderSubmission (sem RLS), mesmo padrão do webhook bancário e
// do webhook da Clicksign.
const insurancePublicWebhook = catchAsync(async (req, res) => {
  const { externalSubmissionId, status, settledAmount } = req.body || {};
  if (typeof externalSubmissionId !== 'string' || !externalSubmissionId || typeof status !== 'string' || !status) {
    return success(res, { statusCode: 400, data: { received: false, reason: 'invalid_payload' } });
  }
  const { sequelize, InsuranceProviderSubmission } = require('../../models');
  const result = await sequelize.transaction(async (t) => {
    const submission = await InsuranceProviderSubmission.findOne({ where: { externalSubmissionId }, transaction: t });
    if (!submission) {
      return { received: true, processed: false, reason: 'unknown_routing' };
    }
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: submission.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: submission.companyId }, transaction: t });

    // Regra crítica (mesmo padrão do webhook do Clicksign, legal.controller.js): se um
    // provedor real estiver configurado pro tenant, a rota DEVE rejeitar qualquer payload sem
    // HMAC válido — nunca aplica "por confiança". O sandbox (sem provedor real por trás, usado
    // nos próprios testes automatizados) segue sem exigir HMAC.
    const tenant = { groupId: submission.groupId, companyId: submission.companyId };
    const providerName = await getSetting('procurement.insurance_provider', tenant, t, 'sandbox');
    if (providerName !== 'sandbox') {
      const webhookSecret = await getDecryptedSetting('procurement.insurance_webhook_secret', tenant, t, null);
      const isValid = verifyInsuranceWebhookSignature(req.rawBody, req.headers, webhookSecret);
      if (!isValid) {
        throw AppError.unauthorized(
          'Assinatura HMAC do webhook de seguro ausente ou inválida para o provedor configurado.',
          'INSURANCE_WEBHOOK_HMAC_INVALID'
        );
      }
    }

    await service.confirmClaimSettlement(externalSubmissionId, status, settledAmount, t);
    return { received: true, processed: true };
  });
  return success(res, { data: result });
});

module.exports = {
  createPolicy, listPolicies, getPolicy, quotePolicy, issuePolicy,
  openClaim, submitClaim, insurancePublicWebhook,
  attachPolicyDocument, listPolicyDocuments,
  listPolicyInstallments, payPolicyInstallment,
  verifyInsuranceWebhookSignature,
};
