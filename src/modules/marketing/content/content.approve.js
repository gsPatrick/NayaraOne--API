'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events');
const repo = require('./pipeline.repository');
const guard = require('./approval.guard');
const { assertTransition, invalidTransition } = require('./pipeline.states');
const { loadLocked, readCheck, newCheck } = require('./pipeline.core');
const { separationOfDuties, contentInvalid } = require('./pipeline.errors');
const { mktError } = require('../marketing.errors');

const ENTITY = 'MarketingContentItem';
const MIN_REASON = 10;

/**
 * Aprovação humana da versão corrente. Aprovar item que não está em PENDING_APPROVAL (inclusive DRAFT sem validação) é
 * 409 MKT_CONTENT_INVALID_TRANSITION. Quem gerou o conteúdo não aprova. Grava approved_by, approved_at e approved_hash (M9-D404),
 * marca checks_json.approval e emite marketing.content.approved. `REJECT` exige motivo e devolve o item a DRAFT.
 */
async function approveContent({ tenant, actor, itemId, input }, transaction) {
  const decision = input.decision === undefined ? 'APPROVE' : String(input.decision).toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) throw contentInvalid('Decisão inválida: use APPROVE ou REJECT.', { field: 'decision' });
  const { item, version } = await loadLocked(itemId, transaction);
  const target = decision === 'APPROVE' ? 'APPROVED' : 'DRAFT';
  assertTransition(item.status, target);
  if (item.status !== 'PENDING_APPROVAL') throw invalidTransition(item.status, target); // a dispensa de aprovação é só da autopublicação
  if (item.created_by && item.created_by === actor) throw separationOfDuties();

  if (decision === 'REJECT') {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < MIN_REASON) throw mktError(400, 'MKT_REASON_REQUIRED', 'Informe o motivo da rejeição (mínimo 10 caracteres).');
    await repo.writeCheck(version.id, 'approval', newCheck(false, { required: true, approved: false, rejected: true, reason, rejectedBy: actor }, null), actor, transaction);
    await repo.setStatus(item.id, 'DRAFT', actor, transaction);
    await audit(tenant, actor, item, 'marketing.content.reject', 'DRAFT', reason, transaction);
    return { itemId: item.id, status: 'DRAFT', versionId: version.id, decision };
  }

  const recorded = await guard.recordApprovedHash(tenant, actor, version.id, transaction);
  await repo.setApprover(version.id, String(actor), actor, transaction);
  const previous = readCheck(version, 'approval');
  await repo.writeCheck(version.id, 'approval', newCheck(true, { ...(previous ? previous.detalhes : {}), required: true, approved: true, approvedBy: actor, approvedHash: recorded.approvedHash }, null), actor, transaction);
  await repo.setStatus(item.id, 'APPROVED', actor, transaction);
  await audit(tenant, actor, item, 'marketing.content.approve', 'APPROVED', 'Versão do conteúdo aprovada.', transaction);
  await publishMarketingEvent({
    type: 'marketing.content.approved', tenant,
    payload: { contentId: item.id, versionNo: version.version_no, approvedBy: actor, autopublished: false },
  }, transaction);
  return { itemId: item.id, status: 'APPROVED', versionId: version.id, decision, approvedHash: recorded.approvedHash };
}

async function audit(tenant, actor, item, action, to, reason, transaction) {
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action, entityType: ENTITY, entityId: item.id,
    beforeJson: { status: item.status }, afterJson: { status: to }, reason,
  }, transaction);
}

module.exports = { approveContent, MIN_REASON };
