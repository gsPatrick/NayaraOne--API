'use strict';

/** GET /finance/antifraud/parameters — valor em vigor dos parâmetros do antifraude (DEC-007, DI-DEC007-2), para a aba Financeiro de Configurações. */
const catchAsync = require('../../../../utils/catchAsync');
const { success } = require('../../../../utils/httpResponse');
const { listAntifraudParameters } = require('../../application/services/antifraud-parameters.service');

const listAntifraudParametersHandler = catchAsync(async (req, res) => {
  const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
  const data = await req.withTenantTransaction((t) => listAntifraudParameters(tenant, t));
  return success(res, { data });
});

module.exports = { listAntifraudParameters: listAntifraudParametersHandler };
