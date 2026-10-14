'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./appraisals.service');

// Worker assíncrono — devolve REQUESTED imediatamente; o job `correspondentAppraisalWorkerJob`
// chama o provider de verdade fora do ciclo de vida do request HTTP.
const createAppraisal = catchAsync(async (req, res) => {
  const appraisal = await req.withTenantTransaction((t) =>
    service.requestAppraisalRecord(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 202, data: appraisal });
});

const listAppraisals = catchAsync(async (req, res) => {
  const appraisals = await req.withTenantTransaction((t) =>
    service.listAppraisals(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: appraisals });
});

module.exports = { createAppraisal, listAppraisals };
