'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./submissions.service');

// Worker assíncrono (Caderno: "Worker chama provider") — este endpoint só faz a parte rápida
// (checklist/elegibilidade/idempotência) e devolve PENDING imediatamente; quem chama o adapter de
// verdade é o job `correspondentSubmissionWorkerJob`, fora do ciclo de vida do request HTTP.
const submitFinancingCase = catchAsync(async (req, res) => {
  const submission = await req.withTenantTransaction((t) =>
    service.requestSubmission(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 202, data: submission });
});

const listSubmissions = catchAsync(async (req, res) => {
  const submissions = await req.withTenantTransaction((t) =>
    service.listSubmissions(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: submissions });
});

const acknowledgeUnknownSubmission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.acknowledgeUnknownSubmission(req.params.submissionId, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

module.exports = { submitFinancingCase, listSubmissions, acknowledgeUnknownSubmission };
