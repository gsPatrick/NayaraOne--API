'use strict';

const crypto = require('node:crypto');
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { run } = require('./campaigns.repository');
const stepsRepo = require('./steps.repository');
const { getCampaignSendPort } = require('./sendPort');
const { assertCampaignRunning } = require('./runnerGuard');
const { isOutboundBlocked } = require('../killswitch.state');
const { readRecipientBatch } = require('./campaigns.settings');
const { STEP_CONTENT_STATUSES } = require('./campaigns.constants');
const { checkApproval } = require('../content').approval;

/** action_key = sha256(campaign_id:step_id:person_id): ocupa o lugar da chave de run da M9-D415 (step de campanha não tem run). */
const actionKeyOf = (campaignId, stepId, personId) => crypto.createHash('sha256').update(`${campaignId}:${stepId}:${personId}`).digest('hex');

const DUE_SQL = `FROM marketing.campaign_steps s JOIN marketing.campaigns c ON c.id = s.campaign_id AND c.company_id = s.company_id
   WHERE s.company_id = :companyId AND s.deleted_at IS NULL AND s.status = 'SCHEDULED' AND c.deleted_at IS NULL
     AND c.starts_at + (s.offset_minutes * interval '1 minute') <= :now`;

/** Step vencido cuja campanha não está RUNNING (ou está com kill switch): o runner recusa a ação (CAMPAIGN_NOT_RUNNING). */
const countBlocked = async (tenant, now, transaction) => (await run(
  `SELECT count(*)::int AS n ${DUE_SQL} AND (c.status <> 'RUNNING' OR c.kill_switch_active)`, { companyId: tenant.companyId, now }, transaction))[0].n;

const dueSteps = (tenant, now, transaction) => run(
  `SELECT s.id ${DUE_SQL} AND c.status = 'RUNNING' AND c.kill_switch_active = false ORDER BY c.starts_at, s.step_no, s.id`, { companyId: tenant.companyId, now }, transaction);

/** Motivo para pular o step (conteúdo/template deixou de ser aprovado válido) ou null se pode seguir. */
async function skipReasonOf(step, tenant, transaction) {
  const [template] = await run('SELECT status FROM marketing.templates WHERE id = :id AND company_id = :companyId', { id: step.template_id, companyId: tenant.companyId }, transaction);
  if (!template || template.status !== 'PUBLISHED') return 'TEMPLATE_NOT_APPROVED';
  if (!step.content_item_id) return null;
  const [item] = await run('SELECT status FROM marketing.content_items WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL', { id: step.content_item_id, companyId: tenant.companyId }, transaction);
  if (!item || !STEP_CONTENT_STATUSES.includes(item.status)) return 'CONTENT_NOT_APPROVED';
  const check = await checkApproval(tenant, null, step.content_item_id, transaction, { origin: 'CAMPAIGN_STEP' });
  return check.invalidated ? 'APPROVAL_INVALID' : null;
}

const pendingRecipients = (campaignId, stepId, tenant, limit, transaction) => run(
  `SELECT DISTINCT m.person_id FROM marketing.campaign_audience_members m
    WHERE m.campaign_id = :campaignId AND m.company_id = :companyId
      AND NOT EXISTS (SELECT 1 FROM marketing.campaign_step_deliveries d WHERE d.step_id = :stepId AND d.person_id = m.person_id)
    ORDER BY m.person_id LIMIT :limit`, { campaignId, stepId, companyId: tenant.companyId, limit }, transaction);

const recordDelivery = (tenant, campaignId, stepId, personId, actionKey, status, reason, externalRef, transaction) => run(
  `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status, reason, external_ref)
   VALUES (:groupId, :companyId, :campaignId, :stepId, :personId, :actionKey, :status, :reason, :externalRef) ON CONFLICT (company_id, action_key) DO NOTHING RETURNING id`,
  { groupId: tenant.groupId, companyId: tenant.companyId, campaignId, stepId, personId, actionKey, status, reason: reason || null, externalRef: externalRef || null }, transaction);

/** Um destinatário: canSend (M9-D418) e, se permitido, o envio pelo adapter do canal (M9-D429). Exceção do adapter vira FAILED. */
async function processRecipient(port, ctx, transaction) {
  const { tenant, campaign, step, personId, now } = ctx;
  const actionKey = actionKeyOf(campaign.id, step.id, personId);
  const portCtx = { tenant, campaign: { id: campaign.id, code: campaign.code, channels: campaign.channels }, step: { id: step.id, stepNo: step.step_no, channel: step.channel, templateId: step.template_id, contentItemId: step.content_item_id }, personId, actionKey, now, transaction };
  let decision;
  try { decision = await port.canSend(portCtx); } catch (err) { logger.error({ err: err.message, stepId: step.id }, 'marketing.campaign.cansend.failed'); decision = { allowed: false, reason: 'CANSEND_ERROR' }; }
  // Horário de silêncio (M9-D429/M9-D418): a mensagem é reagendada, não perdida; sem registro de entrega, o destinatário continua pendente e sai na primeira rodada fora do silêncio.
  if (decision && decision.allowed !== true && decision.reason === 'QUIET_HOURS') return 'DEFERRED';
  if (!decision || decision.allowed !== true) {
    await recordDelivery(tenant, campaign.id, step.id, personId, actionKey, 'BLOCKED', (decision && decision.reason) || 'NOT_ALLOWED', null, transaction);
    return 'BLOCKED';
  }
  let sent;
  try { sent = await port.send(portCtx); } catch (err) { logger.error({ err: err.message, stepId: step.id }, 'marketing.campaign.send.failed'); sent = { ok: false, errorCode: 'SEND_EXCEPTION' }; }
  // Kill switch ligado no meio do lote (M9-D425): nada é registrado para o destinatário, que continua pendente e sai depois da reativação.
  if (sent && sent.errorCode === 'MKT_KILL_SWITCH_ACTIVE') return 'DEFERRED';
  const ok = Boolean(sent && sent.ok);
  await recordDelivery(tenant, campaign.id, step.id, personId, actionKey, ok ? 'SENT' : 'FAILED', ok ? null : (sent && sent.errorCode) || 'SEND_FAILED', sent && sent.externalRef, transaction);
  return ok ? 'SENT' : 'FAILED';
}

async function finishStep(campaign, step, tenant, transaction) {
  const [{ processed }] = await run(
    "SELECT count(*) FILTER (WHERE status IN ('SENT','FAILED'))::int AS processed FROM marketing.campaign_step_deliveries WHERE step_id = :id", { id: step.id }, transaction);
  const status = processed > 0 ? 'SENT' : 'SKIPPED';
  await stepsRepo.setStepStatus(step.id, status, status === 'SKIPPED' ? 'NO_ALLOWED_RECIPIENT' : null, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: `marketing.campaign.step.${status === 'SENT' ? 'sent' : 'skipped'}`, entityType: 'marketing.campaign_step',
    entityId: step.id, beforeJson: { status: 'SCHEDULED' }, afterJson: { status, campaignId: campaign.id, processed },
    reason: status === 'SENT' ? `Step ${step.step_no} da campanha ${campaign.code} processou todos os destinatários.` : `Step ${step.step_no} da campanha ${campaign.code} pulado: nenhum destinatário permitido.`,
  }, transaction);
  return status;
}

async function processStep(port, stepId, tenant, now, transaction, totals) {
  const [step] = await run('SELECT * FROM marketing.campaign_steps WHERE id = :id AND company_id = :companyId FOR UPDATE SKIP LOCKED', { id: stepId, companyId: tenant.companyId }, transaction);
  if (!step || step.status !== 'SCHEDULED') return;
  const guard = await assertCampaignRunning(step.campaign_id, tenant, transaction);
  if (!guard.allowed) { totals.blocked += 1; return; }
  // Kill switch global ou do canal do step (M9-D425): o step continua SCHEDULED, sem nada apagado, e sai no ciclo seguinte à reativação. Estado ilegível também segura.
  if ((await isOutboundBlocked(tenant, { channel: step.channel, campaignId: step.campaign_id }, transaction)).blocked) { totals.blocked += 1; return; }
  const [campaign] = await run('SELECT id, code, channels FROM marketing.campaigns WHERE id = :id AND company_id = :companyId', { id: step.campaign_id, companyId: tenant.companyId }, transaction);

  const reason = await skipReasonOf(step, tenant, transaction);
  if (reason) {
    await stepsRepo.setStepStatus(step.id, 'SKIPPED', reason, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.campaign.step.skipped', entityType: 'marketing.campaign_step', entityId: step.id,
      beforeJson: { status: 'SCHEDULED' }, afterJson: { status: 'SKIPPED', reason }, reason: `Step ${step.step_no} da campanha ${campaign.code} pulado: ${reason}.`,
    }, transaction);
    totals.skipped += 1;
    return;
  }
  const batch = await readRecipientBatch(tenant, transaction);
  const recipients = await pendingRecipients(campaign.id, step.id, tenant, batch, transaction);
  for (const { person_id: personId } of recipients) {
    const outcome = await processRecipient(port, { tenant, campaign, step, personId, now }, transaction);
    totals[outcome.toLowerCase()] += 1;
  }
  if ((await pendingRecipients(campaign.id, step.id, tenant, 1, transaction)).length === 0) {
    if (await finishStep(campaign, step, tenant, transaction) === 'SENT') totals.stepsDone += 1; else totals.skipped += 1;
  }
}

/**
 * Dispara os steps SCHEDULED cujo `starts_at + offset_minutes <= agora`, de campanhas RUNNING (um envio por step e destinatário,
 * idempotente por action_key). Sem porta de envio registrada nada é disparado (os steps continuam SCHEDULED e entram em `deferred`).
 */
async function dispatchDueSteps(tenant, transaction, now) {
  const totals = { sent: 0, blocked: 0, failed: 0, skipped: 0, stepsDone: 0, deferred: 0 };
  totals.blocked += await countBlocked(tenant, now, transaction);
  const due = await dueSteps(tenant, now, transaction);
  const port = getCampaignSendPort();
  if (!port) { totals.deferred = due.length; return totals; }
  for (const { id } of due) {
    try {
      await sequelize.transaction({ transaction }, (inner) => processStep(port, id, tenant, now, inner, totals));
    } catch (err) {
      logger.error({ stepId: id, err: err.message }, 'marketing.campaign.step.failed');
    }
  }
  return totals;
}

module.exports = { dispatchDueSteps, actionKeyOf };
