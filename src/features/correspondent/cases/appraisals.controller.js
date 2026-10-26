'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./appraisals.service');

// A resposta bruta do provider não sai da API. O valor avaliado tem nome próprio (a coluna
// histórica se chama requested_value, mas guarda o valor que o provider avaliou).
function toDto(appraisal) {
  const plain = typeof appraisal.get === 'function' ? appraisal.get({ plain: true }) : { ...appraisal };
  const response = plain.responseSnapshot || null;
  const dto = {
    ...plain,
    manual: Boolean(response && response.manual) || Boolean(plain.requestSnapshot && plain.requestSnapshot.manual),
    appraisedValue: plain.status === 'COMPLETED' ? plain.requestedValue : null,
    failureReason: plain.status === 'FAILED' && response && response.error ? String(response.error) : null,
    inProgress: plain.status === 'REQUESTED',
  };
  delete dto.requestSnapshot;
  delete dto.responseSnapshot;
  return dto;
}

// Provider com API: devolve "em andamento" (202) e o worker conclui. Provider manual: já nasce concluída (201).
const createAppraisal = catchAsync(async (req, res) => {
  const appraisal = await req.withTenantTransaction((t) =>
    service.requestAppraisalRecord(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: appraisal.status === 'REQUESTED' ? 202 : 201, data: toDto(appraisal) });
});

const listAppraisals = catchAsync(async (req, res) => {
  const appraisals = await req.withTenantTransaction((t) =>
    service.listAppraisals(req.params.id, req.auth.groupId, req.auth.companyId, t, { limit: req.query.limit })
  );
  return success(res, { data: appraisals.map(toDto) });
});

module.exports = { createAppraisal, listAppraisals };
