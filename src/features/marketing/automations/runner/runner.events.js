'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../../marketing.events');
const { actionsSummary } = require('./runner.plan');

/** Passo 9: SÓ os nomes do livro (automation.run.started/completed/blocked), pelo outbox, na transação da mudança de estado e com o correlationId da run. */
const emit = (type, payload, tenant, correlationId, transaction) => publishMarketingEvent({ type, tenant, payload, correlationId }, transaction);

const subjectRef = (subject) => (subject ? { type: subject.type, id: subject.id } : 'none');

const emitStarted = ({ tenant, run, flow, version, subject }, transaction) => emit('automation.run.started', { runId: run.id, flowId: flow.id, versionNo: version.versionNo, subject: subjectRef(subject) }, tenant, run.correlation_id, transaction);

/** Término da run: COMPLETED -> completed (resumo por status); BLOCKED -> blocked (motivo). WAITING não emite; FAILED não tem evento (vai para a auditoria interna). */
async function emitEnd({ tenant, run, status, blockedReason, entries, error }, transaction) {
  if (status === 'COMPLETED') {
    await emit('automation.run.completed', { runId: run.id, actionsSummary: actionsSummary(entries) }, tenant, run.correlation_id, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.automation_run.completed', entityType: 'MarketingAutomationRun', entityId: run.id,
      beforeJson: null, afterJson: { status, correlationId: run.correlation_id, actions: entries.map((e) => ({ type: e.type, status: e.status })) }, reason: 'Execução da automação concluída (resultado por ação no registro).',
    }, transaction);
  }
  else if (status === 'BLOCKED') await emit('automation.run.blocked', { runId: run.id, blockedReason }, tenant, run.correlation_id, transaction);
  else if (status === 'FAILED') {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.automation_run.failed', entityType: 'MarketingAutomationRun', entityId: run.id,
      beforeJson: null, afterJson: { status, correlationId: run.correlation_id, actions: entries.map((e) => ({ type: e.type, status: e.status, error_code: e.error_code })) }, reason: `Uma ação da automação falhou: ${error || 'ver o resultado por ação.'}`,
    }, transaction);
  }
}

module.exports = { emitStarted, emitEnd, subjectRef };
