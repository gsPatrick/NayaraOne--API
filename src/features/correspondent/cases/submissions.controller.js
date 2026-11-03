'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./submissions.service');
const AppError = require('../../../utils/AppError');
const { ProviderSubmission } = require('../../../models');

// Quem não pode ler documentos restritos não recebe a referência a eles (fileId) nem o corpo cru
// da resposta do provider: ficam só os dados de acompanhamento do envio.
function redactSubmission(req, submission) {
  if ((req.auth.permissions || []).includes('correspondent:documents:read')) return submission;
  const plain = typeof submission.get === 'function' ? submission.get({ plain: true }) : { ...submission };
  if (plain.requestSnapshot) {
    const { documents, ...rest } = plain.requestSnapshot;
    plain.requestSnapshot = { ...rest, documentsCount: Array.isArray(documents) ? documents.length : 0 };
  }
  delete plain.responseSnapshot;
  return plain;
}

// Worker assíncrono (Caderno: "Worker chama provider") — este endpoint só faz a parte rápida
// (checklist/elegibilidade/idempotência) e devolve PENDING imediatamente; quem chama o adapter de
// verdade é o job `correspondentSubmissionWorkerJob`, fora do ciclo de vida do request HTTP.
const submitFinancingCase = catchAsync(async (req, res) => {
  const submission = await req.withTenantTransaction((t) =>
    service.requestSubmission(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 202, data: redactSubmission(req, submission) });
});

const listSubmissions = catchAsync(async (req, res) => {
  const submissions = await req.withTenantTransaction((t) =>
    service.listSubmissions(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: submissions.map((s) => redactSubmission(req, s)) });
});

const acknowledgeUnknownSubmission = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction(async (t) => {
    const owner = await ProviderSubmission.findOne({ where: { id: req.params.submissionId, groupId: req.auth.groupId, companyId: req.auth.companyId }, attributes: ['id', 'financingCaseId'], transaction: t });
    if (!owner || owner.financingCaseId !== req.params.id) {
      throw AppError.notFound('Submissão não encontrada neste caso.', 'SUBMISSION_NOT_FOUND');
    }
    return service.acknowledgeUnknownSubmission(req.params.submissionId, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t);
  });
  return success(res, { data: result });
});

const resendDocuments = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    service.resendDocumentsToProvider(req.params.id, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: result });
});

module.exports = { submitFinancingCase, listSubmissions, acknowledgeUnknownSubmission, resendDocuments };
