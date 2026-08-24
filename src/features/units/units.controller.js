'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const unitsService = require('./units.service');

const create = catchAsync(async (req, res) => {
  // Defesa em profundidade: group_id/company_id do payload nunca sobrepõem o tenant resolvido
  // no JWT — o RLS do Postgres é a barreira final, mas a aplicação não deve depender só dela
  // (IAM-002 "segurança no servidor", nunca apenas na camada externa/cliente).
  const payload = { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
  const unit = await req.withTenantTransaction((transaction) =>
    unitsService.createUnit(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: unit });
});

const list = catchAsync(async (req, res) => {
  const units = await req.withTenantTransaction((transaction) => unitsService.listUnits(transaction));
  return success(res, { data: units });
});

const getOne = catchAsync(async (req, res) => {
  const unit = await req.withTenantTransaction((transaction) => unitsService.getUnit(req.params.id, transaction));
  return success(res, { data: unit });
});

const update = catchAsync(async (req, res) => {
  const unit = await req.withTenantTransaction((transaction) =>
    unitsService.updateUnit(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: unit });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    unitsService.deleteUnit(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

module.exports = { create, list, getOne, update, remove };
