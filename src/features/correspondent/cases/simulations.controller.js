'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./simulations.service');

const createSimulation = catchAsync(async (req, res) => {
  const simulation = await req.withTenantTransaction((t) =>
    service.createSimulation(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: simulation });
});

const listSimulations = catchAsync(async (req, res) => {
  const simulations = await req.withTenantTransaction((t) =>
    service.listSimulations(req.params.id, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { data: simulations });
});

module.exports = { createSimulation, listSimulations };
