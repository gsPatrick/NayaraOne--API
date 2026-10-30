'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./retention.service');
const { buildPagination } = require('../api-governance/standards/pagination.helper');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });
const tenantOf = (req) => ({ ...tenantFromAuth(req), userId: req.auth.userId });

const listPolicies = async (req, res) => success(res, { data: await req.withTenantTransaction((tx) => service.listPolicies(tenantFromAuth(req), tx)) });

async function putPolicy(req, res) {
  const result = await req.withTenantTransaction((tx) => service.putPolicy(tenantFromAuth(req), actorFrom(req), req.body, tx));
  return success(res, { data: result.policy, meta: { changed: result.changed } });
}

/** POST /retention/dry-run: simula e grava a rodada; o corpo pode limitar as políticas (`policy_codes`). Nada de negócio é alterado. */
async function dryRun(req, res) {
  const codes = req.body && (req.body.policy_codes || req.body.policyCodes);
  const run = await req.withTenantTransaction((tx) => service.runDryRun(tenantFromAuth(req), actorFrom(req), { policyCodes: Array.isArray(codes) ? codes : null, source: 'API' }, tx));
  return success(res, { statusCode: 201, data: run });
}

/** POST /retention/runs/:id/apply: a permissão, a Idempotency-Key, o MFA recente e a confirmação (impacto) já passaram nos middlewares da rota. Cada lote é uma transação. */
async function apply(req, res) {
  const run = await service.applyRun(tenantOf(req), actorFrom(req), req.params.id, { runTx: (fn) => req.withTenantTransaction(fn) });
  return success(res, { data: run });
}

async function listRuns(req, res) {
  const result = await req.withTenantTransaction((tx) => service.listRuns(tenantFromAuth(req), req.query, tx));
  return success(res, { data: result.items, pagination: buildPagination(result) });
}

async function getRun(req, res) {
  const result = await req.withTenantTransaction((tx) => service.getRun(tenantFromAuth(req), req.params.id, req.query, tx));
  return success(res, { data: { run: result.run, items: result.items, itemsTotal: result.itemsTotal }, pagination: buildPagination({ page: result.page, pageSize: result.pageSize, total: result.itemsTotal }) });
}

module.exports = { listPolicies, putPolicy, dryRun, apply, listRuns, getRun };
