'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./automations.service');

// POST /marketing/automations: cria fluxo + versão 1, ou a versão N+1 em DRAFT com `flowId` (M9-D413).
async function create(req, res) {
  const out = await req.withTenantTransaction((t) => service.createAutomation({ tenant: tenantFromAuth(req), actor: req.auth.userId, input: req.body }, t));
  return success(res, { statusCode: 201, data: out });
}

// POST /marketing/automations/:id/publish `{versionNo, reason}`: publica o DRAFT ou retoma o PAUSED; repetir devolve 200.
async function publish(req, res) {
  const out = await req.withTenantTransaction((t) => service.publishAutomation({ tenant: tenantFromAuth(req), actor: req.auth.userId, flowId: req.params.id, input: req.body }, t));
  return success(res, { data: out });
}

// POST /marketing/automations/:id/pause: pausa fluxo e versão juntos, sem apagar configuração.
async function pause(req, res) {
  const out = await req.withTenantTransaction((t) => service.pauseAutomation({ tenant: tenantFromAuth(req), actor: req.auth.userId, flowId: req.params.id, input: req.body }, t));
  return success(res, { data: out });
}

module.exports = { create, publish, pause };
