'use strict';

/**
 * M9-D701 (3.1) — pedido `POST /analytics/exports`, passos síncronos nesta ordem: (1) permissão `analytics:export` e a do domínio; (2) escopo (a empresa da
 * sessão, senão 404); (3) classificação de risco pelas linhas estimadas; (4) MFA se HIGH; (5) congela escopo e filtros e grava o job QUEUED; (6) devolve
 * `{ jobId, status, riskLevel }` (a rota responde 202). Métrica DEGRADED é recusada antes (409 ANALYTICS_EXPORT_DEGRADED_BLOCKED). O pedido sai por
 * `prepareSecureRows` (linha EXPORT_REQUEST no log de acesso) e é auditado pelo store (`analytics.export.request`, DI-D601-8) mais `analytics.export.mfa_approved`.
 */
const { P, prepareSecureRows } = require('../security');
const { createExportJob } = require('../exportJobStore.service');
const { parseExportBody } = require('./export.body');
const { assertExportAccess } = require('./export.access');
const { estimateExportRows } = require('./export.rows');
const { classifyRisk, requireStepUp } = require('./export.risk');
const { readExportParams } = require('./export.settings');
const events = require('./export.events');

/** ctx = { groupId, companyId, actorUserId, permissions }; options = { ip, route }. */
async function requestExport(ctx, body, { ip = null, route = null } = {}, transaction) {
  const plan = parseExportBody(body);
  const access = await assertExportAccess(ctx, plan, transaction);
  const params = await readExportParams(ctx, transaction);
  const estimatedRows = await estimateExportRows(ctx, plan, access, transaction);
  const riskLevel = classifyRisk(estimatedRows, params.riskRows);
  const mfaStepUpId = riskLevel === 'HIGH' ? await requireStepUp(ctx.actorUserId, transaction) : null;
  const frozenScope = {
    kind: plan.kind, code: plan.code, level: plan.level, ...(plan.level === 'GROUP' ? { groupId: ctx.groupId } : { companyId: ctx.companyId }),
    domain: access.domain, asOfDate: plan.asOfDate, estimatedRows, ...(plan.drilldown ? { drilldown: plan.drilldown } : {}),
  };
  const job = await createExportJob({
    companyId: ctx.companyId, groupId: ctx.groupId, requestedBy: ctx.actorUserId, dashboardCode: plan.kind === 'DASHBOARD' ? plan.code : null,
    metricCode: plan.kind === 'DASHBOARD' ? null : plan.code, scope: frozenScope, filters: plan.filters, riskLevel, mfaStepUpId,
  }, ctx, transaction);
  const normalized = { id: job.id, groupId: ctx.groupId, companyId: ctx.companyId, requestedBy: ctx.actorUserId };
  if (mfaStepUpId) {
    await events.audit('mfa_approved', normalized, { actorUserId: ctx.actorUserId, ip, after: { mfaStepUpId, riskLevel, estimatedRows }, reason: 'Exportação de alto risco liberada por MFA recente' }, transaction);
  }
  await events.publish('requested', normalized, { kind: plan.kind, code: plan.code, riskLevel, estimatedRows }, transaction);
  await prepareSecureRows(ctx, {
    permission: P.EXPORT, domain: access.domain, action: 'EXPORT_REQUEST', resourceType: 'EXPORT', resourceCode: job.id, route,
    filters: { target: `${plan.kind}:${plan.code}`, asOfDate: plan.asOfDate, level: plan.level, riskLevel, estimatedRows, ...plan.filters }, rows: [], rowsReturned: estimatedRows, ip, transaction,
  });
  return { jobId: job.id, status: job.status, riskLevel };
}

module.exports = { requestExport };
