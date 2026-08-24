'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const companiesService = require('./companies.service');

// Correção de segurança: todas as ações passam a rodar dentro de req.withTenantTransaction
// (SET LOCAL app.group_id/app.company_id/app.user_id), para que a policy tenant_isolation de
// "core"."companies" (group_id = current_setting('app.group_id')) seja aplicada pelo Postgres.
const create = catchAsync(async (req, res) => {
  const payload = { ...req.body, groupId: req.auth.groupId };
  const company = await req.withTenantTransaction((transaction) =>
    companiesService.createCompany(payload, req.auth.userId, transaction)
  );
  return success(res, { statusCode: 201, data: company });
});

const list = catchAsync(async (req, res) => {
  const companies = await req.withTenantTransaction((transaction) => companiesService.listCompanies(transaction));
  return success(res, { data: companies });
});

const getOne = catchAsync(async (req, res) => {
  const company = await req.withTenantTransaction((transaction) =>
    companiesService.getCompany(req.params.id, transaction)
  );
  return success(res, { data: company });
});

const update = catchAsync(async (req, res) => {
  const company = await req.withTenantTransaction((transaction) =>
    companiesService.updateCompany(req.params.id, req.body, req.auth.userId, transaction)
  );
  return success(res, { data: company });
});

const remove = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((transaction) =>
    companiesService.deleteCompany(req.params.id, req.auth.userId, transaction)
  );
  return success(res, { data: result });
});

module.exports = { create, list, getOne, update, remove };
