'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../governance.module');
const service = require('./api-governance.service');
const { parsePagination } = require('./standards');

async function listConsumers(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.listConsumers({ tenant: tenantFromAuth(req), query: req.query, transaction }));
  return success(res, { data: data.items, pagination: data.pagination });
}

async function createDeprecation(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.createDeprecation({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, body: req.body, transaction }));
  return success(res, { statusCode: 201, data });
}

async function listDeprecations(req, res) {
  const tenant = tenantFromAuth(req);
  const data = await req.withTenantTransaction(async (transaction) => service.listDeprecations({ tenant, query: req.query, paging: await parsePagination(req.query, tenant, transaction), transaction }));
  return success(res, { data: data.items, pagination: data.pagination });
}

async function cancelDeprecation(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.cancelDeprecation({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, id: req.params.id, transaction }));
  return success(res, { data });
}

async function createClient(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.createClient({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, body: req.body, transaction }));
  // O segredo aparece uma vez: a resposta guardada para repetição da Idempotency-Key leva o segredo omitido (nunca fica em claro no banco).
  const { clientSecret, ...rest } = data;
  res.locals.idempotencyStoredBody = { success: true, data: { ...rest, clientSecret: null, secretShown: false } };
  return success(res, { statusCode: 201, data: { ...rest, clientSecret, secretShown: true } });
}

async function listClients(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.listClients({ tenant: tenantFromAuth(req), query: req.query, transaction }));
  return success(res, { data: data.items, pagination: data.pagination });
}

async function revokeClient(req, res) {
  const data = await req.withTenantTransaction((transaction) => service.revokeClient({ tenant: tenantFromAuth(req), actorUserId: req.auth.userId, id: req.params.id, transaction }));
  return success(res, { data });
}

module.exports = { listConsumers, createDeprecation, listDeprecations, cancelDeprecation, createClient, listClients, revokeClient };
