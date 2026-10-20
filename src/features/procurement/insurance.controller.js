'use strict';

const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
const service = require('./insurance.service');
const { assertSandboxAllowed } = require('./adapters/resolveInsuranceAdapter');

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

function actorWithTenant(req) {
  return { userId: req.auth.userId, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

const createPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.createPolicy(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: policy });
});

const listPolicies = catchAsync(async (req, res) => {
  const policies = await req.withTenantTransaction((t) =>
    service.listPolicies({ status: req.query.status, propertyId: req.query.propertyId }, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: policies });
});

const getPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.getPolicy(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: policy });
});

const quotePolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.quotePolicy(req.params.id, req.body, actorWithTenant(req), t));
  return success(res, { data: policy });
});

const issuePolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.issuePolicy(req.params.id, req.body, actorWithTenant(req), t));
  return success(res, { data: policy });
});

const cancelPolicy = catchAsync(async (req, res) => {
  const policy = await req.withTenantTransaction((t) => service.cancelPolicy(req.params.id, req.body, actorWithTenant(req), t));
  return success(res, { data: policy });
});

const openClaim = catchAsync(async (req, res) => {
  const claim = await req.withTenantTransaction((t) => service.openClaim(req.params.id, req.body, actorWithTenant(req), t));
  return success(res, { statusCode: 201, data: claim });
});

const submitClaim = catchAsync(async (req, res) => {
  const claim = await req.withTenantTransaction((t) => service.submitClaim(req.params.id, actorWithTenant(req), t));
  return success(res, { data: claim });
});

const attachPolicyDocument = catchAsync(async (req, res) => {
  const link = await req.withTenantTransaction((t) =>
    service.attachPolicyDocument(req.params.id, req.body.fileId, actorWithTenant(req), t)
  );
  return success(res, { statusCode: 201, data: link });
});

const listPolicyDocuments = catchAsync(async (req, res) => {
  const links = await req.withTenantTransaction((t) => service.listPolicyDocuments(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: links });
});

const listPolicyInstallments = catchAsync(async (req, res) => {
  const installments = await req.withTenantTransaction((t) => service.listPolicyInstallments(req.params.id, req.auth.groupId, req.auth.companyId, t));
  return success(res, { data: installments });
});

const payPolicyInstallment = catchAsync(async (req, res) => {
  const installment = await req.withTenantTransaction((t) =>
    service.payInsurancePolicyInstallment(req.params.installmentId, req.body.financialEntryId, actorWithTenant(req), t)
  );
  return success(res, { data: installment });
});

// Webhook público da seguradora — SEM authMiddleware/tenantMiddleware (ver routes/index.js),
// resolve tenant via InsuranceProviderSubmission (sem RLS), mesmo padrão do webhook bancário e
// do webhook da Clicksign.
// REVISÃO MARCO 7 (19/10/2026, B6): o sandbox aceitava a chamada SEM HMAC — qualquer pessoa que
// soubesse o id externo forjava uma indenização com valor arbitrário. Agora:
//   - HMAC é exigido SEMPRE, inclusive no sandbox (sem segredo configurado → recusa, fail-closed);
//   - com DEPLOY_ENVIRONMENT=production o sandbox é recusado;
//   - o valor é limitado ao sinistro/cobertura (insurance.service#confirmClaimSettlement).
// processInsuranceWebhook recebe a transação de fora para ser testável em banco real com rollback.
async function processInsuranceWebhook(body, rawBody, headers, transaction) {
  const { externalSubmissionId, status, settledAmount } = body || {};
  if (typeof externalSubmissionId !== 'string' || !externalSubmissionId || typeof status !== 'string' || !status) {
    return { statusCode: 400, data: { received: false, reason: 'invalid_payload' } };
  }
  const { sequelize, InsuranceProviderSubmission } = require('../../models');
  const submission = await InsuranceProviderSubmission.findOne({ where: { externalSubmissionId }, transaction });
  if (!submission) {
    return { statusCode: 200, data: { received: true, processed: false, reason: 'unknown_routing' } };
  }
  await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: submission.groupId }, transaction });
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: submission.companyId }, transaction });

  const tenant = { groupId: submission.groupId, companyId: submission.companyId };
  const webhookSecret = await getDecryptedSetting('procurement.insurance_webhook_secret', tenant, transaction, null);
  const isValid = verifyInsuranceWebhookSignature(rawBody, headers, webhookSecret);
  if (!isValid) {
    throw AppError.unauthorized(
      'Assinatura HMAC do webhook de seguro ausente ou inválida.',
      'INSURANCE_WEBHOOK_HMAC_INVALID'
    );
  }
  const providerName = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  if (providerName === 'sandbox' || submission.provider === 'sandbox') assertSandboxAllowed();

  await service.confirmClaimSettlement(externalSubmissionId, status, settledAmount, transaction);
  return { statusCode: 200, data: { received: true, processed: true } };
}

// Webhook público da seguradora — SEM authMiddleware/tenantMiddleware (ver routes/index.js),
// resolve tenant via InsuranceProviderSubmission (sem RLS), mesmo padrão do webhook bancário e
// do webhook da Clicksign.
const insurancePublicWebhook = catchAsync(async (req, res) => {
  const { sequelize } = require('../../models');
  const result = await sequelize.transaction((t) => processInsuranceWebhook(req.body, req.rawBody, req.headers, t));
  return success(res, { statusCode: result.statusCode, data: result.data });
});

module.exports = {
  createPolicy, listPolicies, getPolicy, quotePolicy, issuePolicy, cancelPolicy,
  openClaim, submitClaim, insurancePublicWebhook,
  attachPolicyDocument, listPolicyDocuments,
  listPolicyInstallments, payPolicyInstallment,
  verifyInsuranceWebhookSignature,
  processInsuranceWebhook,
};
