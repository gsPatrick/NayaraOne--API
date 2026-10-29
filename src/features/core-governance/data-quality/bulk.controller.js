'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./bulk.service');
const { buildPagination } = require('../api-governance/standards/pagination.helper');

const actorFrom = (req) => ({ userId: req.auth.userId, roles: req.auth.roles || [] });
const paging = buildPagination;

/** POST /data-quality/bulk-changes: a permissão, a Idempotency-Key e o MFA recente já foram checados nos middlewares da rota. */
async function create(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.executeBulk(tenantFromAuth(req), actorFrom(req), req.body, { idempotencyKey: req.get('Idempotency-Key') }, transaction));
  if (result.replayed) res.set('Idempotent-Replay', 'true');
  return success(res, { data: result.lot });
}

async function impact(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.impactOf(tenantFromAuth(req), req.body, transaction));
  return success(res, { data });
}

async function getOne(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.getBulkChange(tenantFromAuth(req), req.params.id, req.query, transaction));
  return success(res, { data: { lot: result.lot, items: result.items, itemsTotal: result.itemsTotal }, pagination: paging({ page: result.page, pageSize: result.pageSize, total: result.itemsTotal }) });
}

async function list(req, res) {
  const result = await req.withTenantTransaction((transaction) => service.listBulkChanges(tenantFromAuth(req), req.query, transaction));
  return success(res, { data: result.items, pagination: paging(result) });
}

module.exports = { create, impact, getOne, list };
