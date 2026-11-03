'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const service = require('./webhooks.service');

// Webhook público — sem authMiddleware/tenantMiddleware (chamado pelo provider externo, não por
// um usuário logado do Nayara One). O tenant é resolvido de dentro do próprio service (ver
// webhooks.service.js#resolveTenantByExternalId). Mesmo padrão de resposta "sempre 200 com
// received/processed" dos outros webhooks públicos do projeto (clicksignPublicWebhook,
// insurancePublicWebhook, bankPaymentPublicWebhook) — EXCETO quando a assinatura é inválida, que
// aí sim propaga 401 (catchAsync -> errorHandler), porque isso precisa ser visivelmente rejeitado
// (não um 200 "recebido mas ignorado").
const financingPublicWebhook = catchAsync(async (req, res) => {
  const result = await service.processFinancingWebhook(req.params.provider, req.rawBody, req.headers, req.body);
  return success(res, { data: result });
});

const getFinancingCaseStatus = catchAsync(async (req, res) => {
  const status = await req.withTenantTransaction((t) =>
    service.getCaseStatus(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: status });
});

module.exports = { financingPublicWebhook, getFinancingCaseStatus };
