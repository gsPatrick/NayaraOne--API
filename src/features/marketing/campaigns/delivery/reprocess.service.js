'use strict';

const { sequelize } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const campaignRepo = require('../campaigns.repository');
const stepsRepo = require('../steps.repository');
const { run } = require('../campaigns.repository');
const { getCampaignSendPort } = require('../sendPort');
const { isUuid } = require('../campaigns.validation');
const { campaignNotFound, campaignFinal, notRunning, sendUnavailable, validation } = require('../campaigns.errors');
const repo = require('./delivery.repository');
const { auditDelivery } = require('./delivery.audit');
const { portCtxOf } = require('./delivery.closing');
const { STATUS, CODES, REPROCESSABLE_FAILED, REPROCESS_AS_UNKNOWN, MIN_REPROCESS_REASON } = require('./delivery.constants');

/** Entregas da campanha que vieram de falha transitória (ou incerteza) e podem voltar à fila; steps pulados ou cancelados ficam de fora. */
const reprocessableRows = (campaignId, stepId, tenant, transaction) => run(
  `SELECT d.${repo.COLS.split(', ').join(', d.')}, s.status AS step_status, s.status_reason AS step_reason, s.step_no, s.channel, s.template_id, s.content_item_id, c.code AS campaign_code, c.channels
     FROM marketing.campaign_step_deliveries d
     JOIN marketing.campaign_steps s ON s.id = d.step_id AND s.company_id = d.company_id AND s.deleted_at IS NULL
     JOIN marketing.campaigns c ON c.id = d.campaign_id AND c.company_id = d.company_id
    WHERE d.campaign_id = :campaignId AND d.company_id = :companyId AND (CAST(:stepId AS uuid) IS NULL OR d.step_id = CAST(:stepId AS uuid))
      AND s.status IN ('SENT','SCHEDULED')
      AND ((d.status = 'FAILED' AND d.reason IN (:codes)) OR (d.status = 'BLOCKED' AND d.reason = :cansend))
    ORDER BY d.step_id, d.person_id FOR UPDATE OF d`,
  { campaignId, stepId: stepId || null, companyId: tenant.companyId, codes: REPROCESSABLE_FAILED, cansend: CODES.CANSEND_ERROR }, transaction
);

function parseInput(body) {
  const reason = typeof (body && body.reason) === 'string' ? body.reason.trim() : '';
  if (reason.length < MIN_REPROCESS_REASON) throw validation(`Informe o motivo do reprocessamento (mínimo ${MIN_REPROCESS_REASON} caracteres).`, { field: 'reason' });
  const stepId = body && body.stepId !== undefined && body.stepId !== null ? body.stepId : null;
  if (stepId !== null && !isUuid(stepId)) throw validation('O campo "stepId" deve ser um identificador válido.', { field: 'stepId' });
  return { reason, stepId };
}

/** Uma entrega volta: RETRY (nada saiu; a mensagem do CRM fechada por tentativas esgotadas volta à fila) ou UNKNOWN (pode ter saído: reconciliar antes). */
async function reopenOne(row, ctx, transaction) {
  const asUnknown = REPROCESS_AS_UNKNOWN.includes(row.reason);
  const next = asUnknown ? STATUS.UNKNOWN : STATUS.RETRY;
  if (!asUnknown && typeof ctx.port.reopen === 'function') await ctx.port.reopen(portCtxOf(row, ctx.tenant, ctx.now, transaction));
  await repo.updateDelivery(row.id, ctx.tenant, { status: next, reason: row.reason, attempts: 0, rateDeferrals: 0, reconcileAttempts: 0, nextAttemptAt: ctx.now }, transaction);
  await auditDelivery(ctx.tenant, 'reprocessed', row.id, {
    actorUserId: ctx.actor, before: { status: row.status, reason: row.reason, attempts: row.attempts }, after: { status: next, nextAttemptAt: ctx.now.toISOString() }, reason: ctx.reason,
  }, transaction);
  return next;
}

/** Step que já tinha fechado como SENT volta a SCHEDULED para o disparo pegar as entregas reabertas. */
async function reopenStep(stepId, stepNo, ctx, transaction) {
  await stepsRepo.setStepStatus(stepId, 'SCHEDULED', null, transaction);
  await registrarAuditoria({
    groupId: ctx.tenant.groupId, companyId: ctx.tenant.companyId, actorUserId: ctx.actor, action: 'marketing.campaign.step.reopened', entityType: 'marketing.campaign_step', entityId: stepId,
    beforeJson: { status: 'SENT' }, afterJson: { status: 'SCHEDULED' }, reason: `Step ${stepNo} da campanha ${ctx.code} reaberto pelo reprocessamento: ${ctx.reason}`,
  }, transaction);
}

/**
 * POST /marketing/campaigns/:id/deliveries/reprocess (verificação K=7, itens 5 e 14): o caminho AUDITADO para as entregas que ficaram FAILED por falha transitória
 * (por exemplo a campanha cfc5c8e1 da homologação, FAILED MKT_UNSUBSCRIBE_KEY_UNAVAILABLE com o cofre fora). Permissão marketing:campaign:manage (a mesma de
 * agendar a campanha que envia a essas pessoas), motivo obrigatório, campanha em andamento. Nada é enviado aqui: as entregas voltam a RETRY/UNKNOWN com hora
 * de agora e o disparo da campanha as processa no ciclo seguinte, com canSend NA HORA (quem pediu opt-out depois não recebe) e a mesma action_key (nunca
 * duplica: UNKNOWN reconcilia antes). Recusa definitiva (endereço, conteúdo, credencial, validação) nunca é reprocessada. Repetir sem nada elegível = 0.
 */
async function reprocessDeliveries(tenant, actor, campaignId, body, transaction, { now = new Date() } = {}) {
  if (!isUuid(campaignId)) throw campaignNotFound();
  const input = parseInput(body);
  return sequelize.transaction({ transaction }, async (t) => {
    const campaign = await campaignRepo.findById(campaignId, tenant, t, { lock: true });
    if (!campaign) throw campaignNotFound();
    if (campaign.status === 'ENDED') throw campaignFinal();
    if (campaign.status !== 'RUNNING' || new Date(campaign.ends_at) <= now) throw notRunning(campaign.status);
    const port = getCampaignSendPort();
    if (!port) throw sendUnavailable();
    const rows = await reprocessableRows(campaign.id, input.stepId, tenant, t);
    const ctx = { tenant, actor, now, port, reason: input.reason, code: campaign.code };
    const out = { campaignId: campaign.id, reprocessed: rows.length, asRetry: 0, asUnknown: 0, stepsReopened: 0, nextAttemptAt: rows.length ? now.toISOString() : null };
    const reopened = new Map();
    for (const row of rows) {
      if ((await reopenOne(row, ctx, t)) === STATUS.UNKNOWN) out.asUnknown += 1; else out.asRetry += 1;
      if (row.step_status === 'SENT') reopened.set(row.step_id, row.step_no);
    }
    for (const [stepId, stepNo] of reopened) await reopenStep(stepId, stepNo, ctx, t);
    out.stepsReopened = reopened.size;
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.campaign.deliveries.reprocess', entityType: 'marketing.campaign', entityId: campaign.id,
      beforeJson: { deliveries: rows.map((r) => ({ id: r.id, status: r.status, reason: r.reason })) }, afterJson: { ...out, stepId: input.stepId }, reason: input.reason,
    }, t);
    return out;
  });
}

module.exports = { reprocessDeliveries };
