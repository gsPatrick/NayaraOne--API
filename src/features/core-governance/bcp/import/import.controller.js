'use strict';

const { success } = require('../../../../utils/httpResponse');
const { tenantFromAuth } = require('../../governance.module');
const { importBatch } = require('./import.batch');
const decideService = require('./decide.service');

const actor = (req) => ({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId });

async function importOperations(req, res) {
  const data = await req.withTenantTransaction((transaction) => importBatch({ ...actor(req), body: req.body, transaction }));
  return success(res, { data });
}

async function listReconciliations(req, res) {
  const data = await req.withTenantTransaction((transaction) => decideService.list({ ...actor(req), query: req.query, transaction }));
  return success(res, { data });
}

async function decide(req, res) {
  const data = await req.withTenantTransaction((transaction) => decideService.decide({ ...actor(req), id: req.params.id, body: req.body, transaction }));
  return success(res, { data });
}

module.exports = { importOperations, listReconciliations, decide };
