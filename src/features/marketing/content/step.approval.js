'use strict';

const repo = require('./pipeline.repository');
const guard = require('./approval.guard');
const { evaluateApprovalPolicy } = require('./pipeline.approvalPolicy');

/**
 * M9-D406 função 6 — requestApprovalIfRequired(contentVersion): decide a aprovação (M9-D408). Padrão: PENDING_APPROVAL (aprovação
 * humana). Só uma classe autopublicável (parâmetro marketing.autopublish.classes, autopublish.policy) leva direto a APPROVED, com approved_by
 * `SYSTEM_AUTOPUBLISH:{classe}` e o approved_hash gravado pelo mesmo guard da aprovação humana.
 */
async function approvalStep({ item, version, tenant, actor, transaction }) {
  const decision = await evaluateApprovalPolicy({ item, version, tenant, transaction });
  if (!decision || !decision.autopublish) {
    return { ok: true, to: 'PENDING_APPROVAL', detalhes: { required: true, approved: false } };
  }
  const approvedBy = `SYSTEM_AUTOPUBLISH:${decision.classId}`;
  const recorded = await guard.recordApprovedHash(tenant, actor, version.id, transaction);
  await repo.setApprover(version.id, approvedBy, actor, transaction);
  await repo.setAutopublishClass(item.id, decision.classId, actor, transaction);
  return {
    ok: true,
    to: 'APPROVED',
    detalhes: {
      required: false, approved: true, autopublished: true, classId: decision.classId, classIds: decision.classIds || [decision.classId], approvedBy,
      approvedHash: recorded.approvedHash, channels: decision.channels || null, quando: decision.quando || 0,
    },
  };
}

module.exports = { approvalStep };
