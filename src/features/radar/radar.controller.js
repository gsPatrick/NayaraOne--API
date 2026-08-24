'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const radarService = require('./radar.service');

const create = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const { radar, matches } = await req.withTenantTransaction((transaction) =>
    radarService.createRadar(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: { ...radar.toJSON(), matches } });
});

const list = catchAsync(async (req, res) => {
  const radars = await req.withTenantTransaction((transaction) =>
    radarService.listRadars(transaction, { personId: req.query.personId, status: req.query.status })
  );
  return success(res, { data: radars });
});

const getOne = catchAsync(async (req, res) => {
  const radar = await req.withTenantTransaction((transaction) => radarService.getRadar(req.params.id, transaction));
  return success(res, { data: radar });
});

const update = catchAsync(async (req, res) => {
  const { radar, matches } = await req.withTenantTransaction((transaction) =>
    radarService.updateRadar(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: { ...radar.toJSON(), matches } });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    radarService.deleteRadar(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

const matches = catchAsync(async (req, res) => {
  const results = await req.withTenantTransaction((transaction) => radarService.getRadarMatches(req.params.id, transaction));
  return success(res, { data: results });
});

module.exports = { create, list, getOne, update, remove, matches };
