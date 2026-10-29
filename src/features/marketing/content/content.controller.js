'use strict';

const { success } = require('../../../utils/httpResponse');
const { tenantFromAuth } = require('../marketing.module');
const service = require('./content.service');
const { parseCreateBody, parseScheduleBody, parseApproveBody } = require('./content.input');
const { factCheckFailed } = require('./pipeline.errors');

// POST /marketing/content: cria e percorre o pipeline até a aprovação (M9-D406). NAY fora do ar: o item fica DRAFT e a resposta é 503.
async function create(req, res) {
  const input = parseCreateBody(req.body);
  const out = await service.createAndRun({ tenant: tenantFromAuth(req), actor: req.auth.userId, input }, req.withTenantTransaction);
  if (out.nayError) throw service.nayUnavailable({ ...out.nayError.details, contentItemId: out.content.id });
  // M9-D407: reprovado pelo validador factual = 422 com os findings; o item (FACT_CHECK_FAILED) fica salvo para revisão.
  if (out.content.status === 'FACT_CHECK_FAILED' && out.content.findings.length > 0) {
    throw factCheckFailed(out.content.findings, { contentItemId: out.content.id, status: out.content.status });
  }
  return success(res, { statusCode: out.created ? 201 : 200, data: out.content });
}

// POST /marketing/content/:id/approve: aprovação humana (M9-D406 máquina de estados; M9-D408 acrescenta as regras de classe).
async function approve(req, res) {
  const input = parseApproveBody(req.body);
  const data = await req.withTenantTransaction((t) => service.approve({ tenant: tenantFromAuth(req), actor: req.auth.userId, itemId: req.params.id, input }, t));
  return success(res, { data });
}

// POST /marketing/content/:id/schedule: um job por canal (M9-D406 agendamento; M9-D410 acrescenta publicação e reprocesso).
async function schedule(req, res) {
  const input = parseScheduleBody(req.body);
  const out = await req.withTenantTransaction((t) => service.schedule({ tenant: tenantFromAuth(req), actor: req.auth.userId, itemId: req.params.id, ...input }, t));
  if (out.error) throw out.error;
  return success(res, { statusCode: out.replay ? 200 : 201, data: { itemId: out.itemId, status: out.status, versionId: out.versionId, jobs: out.jobs, step: out.step } });
}

// GET /marketing/content/:id (I1): linha do tempo do conteúdo com o checks_json de cada passo.
async function get(req, res) {
  const data = await req.withTenantTransaction((t) => service.getContent(tenantFromAuth(req), req.params.id, t));
  return success(res, { data });
}

module.exports = { create, approve, schedule, get };
