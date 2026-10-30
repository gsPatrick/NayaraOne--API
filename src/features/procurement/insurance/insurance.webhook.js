'use strict';

const { InsurancePolicy, InsuranceProviderSubmission, Notification } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { recordError } = require('../../integrations/errors');
const { registerDomainHandler } = require('../../integrations/webhooks/worker/worker.handlers');

/** Ordem dos status da apólice: o status mais antigo que o já aplicado não regride a apólice. */
const RANK = Object.freeze({ PENDING: 1, QUOTED: 2, APPROVED: 3, ISSUED: 4, ACTIVE: 5, EXPIRED: 6, CANCELED: 7 });
const POLICY_RANK = Object.freeze({ DRAFT: 0, QUOTED: 2, ISSUED: 4, ACTIVE: 5, EXPIRED: 6, CANCELED: 7, CANCELLED: 7 });

const refuse = (ctx, row, code, message, transaction) => recordError(ctx, {
  providerCode: row.providerCode, connectionId: row.connectionId || null, source: 'WEBHOOK', sourceRefId: row.id, operation: 'webhook.insurance', errorClass: 'VALIDATION', severity: 'MEDIUM', errorCode: code, message,
  payload: { inboxId: row.id, externalEventId: row.externalEventId }, allowlist: ['inboxId', 'externalEventId'],
}, transaction);

const audit = (ctx, policy, action, reason, extra, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action, entityType: 'InsurancePolicy', entityId: policy.id, afterJson: extra || null, reason,
}, transaction);

/** A apólice do evento: pelo identificador que a seguradora devolveu na emissão (registro da submissão da própria empresa). */
async function findPolicy(ctx, externalPolicyId, transaction) {
  const envio = await InsuranceProviderSubmission.findOne({ where: { companyId: ctx.companyId, submissionType: 'ISSUE', externalSubmissionId: externalPolicyId }, transaction });
  return envio ? InsurancePolicy.findOne({ where: { id: envio.policyId, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE }) : null;
}

async function warn(policy, title, body, transaction) {
  if (!policy.createdBy) return;
  await Notification.create({ groupId: policy.groupId, companyId: policy.companyId, userId: policy.createdBy, channel: 'IN_APP', title, body }, { transaction });
}

/**
 * Tratador do domínio INSURANCE do worker da caixa de entrada (M9-D212 + M9-D238 3.4): aplica o status da apólice que a seguradora informou por webhook assinado. EMITIDA vira
 * VIGENTE (ISSUED -> ACTIVE); o envio da proposta é confirmado pelo worker com este mesmo status. Cancelamento e vencimento informados pela seguradora não mudam a apólice sozinhos
 * (têm efeito financeiro e de calendário, e o vencimento é do job pela data): geram auditoria e aviso à pessoa responsável. Status mais antigo que o aplicado não regride a apólice.
 */
async function applyInsuranceEvent(ctx, row, ev, transaction) {
  if (!ev.data || ev.data.kind !== 'POLICY_STATUS') return { applied: false };
  const policy = await findPolicy(ctx, ev.data.externalPolicyId, transaction);
  if (!policy) {
    await refuse(ctx, row, 'INTEGRATION_INSURANCE_POLICY_UNKNOWN', 'Evento de uma apólice que o sistema não conhece.', transaction);
    return { applied: false };
  }
  const status = String(ev.internalStatus || '').toUpperCase();
  const atual = POLICY_RANK[policy.status] ?? 0;
  if ((RANK[status] || 0) < atual) {
    await audit(ctx, policy, 'procurement.insurance_policy.event_ignored', `Status ${status} da seguradora ignorado: a apólice está ${policy.status}.`, null, transaction);
    return { applied: false };
  }
  if (status === 'ACTIVE' && policy.status === 'ISSUED') {
    await policy.update({ status: 'ACTIVE' }, { transaction });
    await audit(ctx, policy, 'procurement.insurance_policy.provider_status', 'A seguradora informou a apólice vigente.', { status }, transaction);
    return { applied: true };
  }
  if (status === 'CANCELED' || status === 'EXPIRED') {
    await audit(ctx, policy, 'procurement.insurance_policy.provider_status', `A seguradora informou ${status === 'CANCELED' ? 'o cancelamento' : 'o vencimento'} da apólice.`, { status }, transaction);
    await warn(policy, 'Seguradora informou mudança na apólice', `A seguradora informou ${status === 'CANCELED' ? 'o cancelamento' : 'o vencimento'} da apólice ${policy.externalPolicyNumber || policy.id}: revise e trate no sistema.`, transaction);
    return { applied: true };
  }
  return { applied: true };
}

let installed = false;
function installInsuranceEvents() {
  if (installed) return;
  installed = true;
  registerDomainHandler('INSURANCE', applyInsuranceEvent);
}

module.exports = { applyInsuranceEvent, installInsuranceEvents };
