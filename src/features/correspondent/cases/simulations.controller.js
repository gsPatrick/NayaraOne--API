'use strict';

const catchAsync = require('../../../utils/catchAsync');
const { success } = require('../../../utils/httpResponse');
const service = require('./simulations.service');

// O que o provider devolveu em bruto não sai da API: a tela recebe só os campos de negócio.
function toDto(simulation) {
  const plain = typeof simulation.get === 'function' ? simulation.get({ plain: true }) : { ...simulation };
  const manual = Boolean(plain.requestSnapshot && plain.requestSnapshot.manual);
  delete plain.requestSnapshot;
  delete plain.responseSnapshot;
  return { ...plain, manual, rateInformed: plain.rate !== null && plain.rate !== undefined };
}

const createSimulation = catchAsync(async (req, res) => {
  const simulation = await req.withTenantTransaction((t) =>
    service.createSimulation(req.params.id, req.body, req.auth.userId, req.auth.groupId, req.auth.companyId, t)
  );
  return success(res, { statusCode: 201, data: toDto(simulation) });
});

const listSimulations = catchAsync(async (req, res) => {
  const simulations = await req.withTenantTransaction((t) =>
    service.listSimulations(req.params.id, req.auth.groupId, req.auth.companyId, t, { limit: req.query.limit })
  );
  return success(res, { data: simulations.map(toDto) });
});

module.exports = { createSimulation, listSimulations };
