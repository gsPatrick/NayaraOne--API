'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./publications.service');

// GET /marketing/publications (M9-D410): lista paginada com status por canal; exige marketing:content:read.
async function list(req, res) {
  const out = await req.withTenantTransaction((t) => service.listPublications(tenantFromAuth(req), req.query, t));
  return success(res, { data: out.items, pagination: out.pagination });
}

// POST /marketing/publications/:id/cancel (M9-D410): a confirmação com impacto (nível 2) já passou pelo guarda da rota.
async function cancel(req, res) {
  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : undefined;
  const data = await req.withTenantTransaction((t) => service.cancelJob({ tenant: tenantFromAuth(req), actor: req.auth.userId, jobId: req.params.id, reason }, t));
  return success(res, { data });
}

// O corpo de GET /marketing/publications/:id/impact é montado pelo guarda de impacto (linha 18 do inventário); este é só o final da cadeia.
async function impactFallback(req, res, next) {
  return next(require('./schedule/schedule.errors').jobNotFound());
}

module.exports = { list, cancel, impactFallback };
