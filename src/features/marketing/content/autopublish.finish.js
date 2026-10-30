'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishMarketingEvent } = require('../marketing.events');
const repo = require('./pipeline.repository');
const approvalRepo = require('./approval.repository');
const { loadLocked, newCheck } = require('./pipeline.core');
const { readMinLeadMinutes } = require('./pipeline.settings');

const ENTITY = 'MarketingContentItem';
const MINUTE = 60000;

/** Horário da autopublicação: agora + antecedência mínima (+ espera da classe), arredondado ao minuto SEGUINTE (M9-D408 item 5; respeita a M9-D406). */
async function autopublishTime(tenant, quando, now, transaction) {
  const base = now.getTime() + (await readMinLeadMinutes(tenant, transaction) + (quando || 0)) * MINUTE;
  return new Date(Math.floor(base / MINUTE) * MINUTE + MINUTE);
}

/** Desfaz a dispensa de aprovação: o conteúdo volta a PENDING_APPROVAL, sem aprovação nem classe, e a razão fica na auditoria e no passo. */
async function revertToPending({ tenant, actor, item, version, error }, transaction) {
  await approvalRepo.clearApprovals(item.id, actor || null, transaction);
  await approvalRepo.setItemPendingApproval(item.id, actor || null, transaction);
  await repo.setAutopublishClass(item.id, null, actor || null, transaction);
  await repo.writeCheck(version.id, 'approval', newCheck(true, { required: true, approved: false, autopublishReverted: error.code || 'ERROR' }, null), actor || null, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor || null, action: 'marketing.content.autopublish_reverted', entityType: ENTITY, entityId: item.id,
    beforeJson: { status: 'APPROVED' }, afterJson: { status: 'PENDING_APPROVAL', error: error.code || 'ERROR' }, reason: `Autopublicação desfeita: ${error.message}`,
  }, transaction);
}

/**
 * Depois do passo de aprovação que dispensou a pessoa (M9-D408 item 5): num savepoint, emite `marketing.content.approved` com `autopublished = true` e agenda nos
 * canais da classe. Se o agendamento falhar por regra (conexão inativa, canal sem liberação social, kill switch que ligou agora...), tudo do savepoint é desfeito e o
 * conteúdo volta a PENDING_APPROVAL: nunca fica aprovado sem agenda. Erro que não é de regra (5xx) sobe. `schedule` é schedulePublication (injetado: evita ciclo).
 */
async function finishAutopublish(ctx, result, transaction, schedule) {
  const { tenant, actor } = ctx;
  const now = ctx.now || new Date();
  const { item, version } = await loadLocked(result.itemId, transaction);
  const detail = result.step.detalhes;
  try {
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await publishMarketingEvent({
        type: 'marketing.content.approved', tenant,
        payload: { contentId: item.id, versionNo: version.version_no, approvedBy: item.created_by || actor || null, autopublished: true },
      }, savepoint);
      const when = await autopublishTime(tenant, detail.quando, now, savepoint);
      const scheduled = await schedule({ tenant, actor, itemId: item.id, channels: detail.channels, when, now }, savepoint);
      if (scheduled.approvalInvalidated) throw Object.assign(new Error('A aprovação foi invalidada ao agendar.'), { code: 'MKT_APPROVAL_INVALIDATED', statusCode: 409 });
      return scheduled;
    });
  } catch (error) {
    if (!(error.statusCode && error.statusCode < 500)) throw error;
    await revertToPending({ tenant, actor, item, version, error }, transaction);
    return { ...result, status: 'PENDING_APPROVAL', autopublishReverted: error.code || 'ERROR' };
  }
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor || null, action: 'marketing.content.autopublish', entityType: ENTITY, entityId: item.id,
    beforeJson: { status: 'COMPLIANCE_CHECKED' }, afterJson: { status: 'SCHEDULED', classId: detail.classId, channels: detail.channels }, reason: `Conteúdo da NAY autopublicado pela classe ${detail.classId}.`,
  }, transaction);
  const fresh = await repo.lockItem(item.id, transaction);
  return { ...result, status: fresh.status };
}

module.exports = { finishAutopublish, autopublishTime };
