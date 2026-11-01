'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./feature-flags.service');
const { auditDeniedSettingWrite } = require('../../settings/settingDenied');

const run = (req, work) => req.withTenantTransaction((transaction) => work(tenantFromAuth(req), transaction));

async function list(req, res) {
  return success(res, { data: await run(req, (tenant, tx) => service.listEntries(tenant, req.query, req.auth.userId, tx)) });
}

/** Recusa por chave protegida: a transação desfez tudo; a tentativa vira linha em audit.audit_log (R4-L3) e a resposta 403 segue igual. */
async function auditDenial(req, via, err) {
  await auditDeniedSettingWrite(req, { key: err && err.details && err.details.key, via, err });
  throw err;
}

async function create(req, res) {
  const data = await run(req, (tenant, tx) => service.createEntry(tenant, req.body, req.auth.userId, tx)).catch((err) => auditDenial(req, 'POST /feature-flags', err));
  return success(res, { data, statusCode: 201 });
}

async function update(req, res) {
  const data = await run(req, (tenant, tx) => service.updateEntry(tenant, req.body, req.auth.userId, tx, { permissions: req.auth.permissions })).catch((err) => auditDenial(req, 'PATCH /feature-flags', err));
  return success(res, { data });
}

module.exports = { list, create, update };
