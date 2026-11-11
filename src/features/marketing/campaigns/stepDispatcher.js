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
const { massStepReason } = require('./massStep.guard');
const deliveries = require('./delivery/delivery.repository');
const { processRecipient } = require('./delivery/delivery.recipient');
const { readDeliveryPolicy } = require('../sendRetry.policy');
const { closeOpenOfClosedSteps } = require('./delivery/delivery.closing');

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
  const [campaign] = await run('SELECT id, code, channels, mass_confirmed_by FROM marketing.campaigns WHERE id = :id AND company_id = :companyId', { id: step.campaign_id, companyId: tenant.companyId }, transaction);

  const reason = await massStepReason(campaign, tenant, transaction) || await skipReasonOf(step, tenant, transaction); // M9-D433: o teto de massa vale a cada step
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
  const policy = await readDeliveryPolicy(tenant, transaction);
  const recipients = await deliveries.dueRecipients(campaign.id, step.id, tenant, now, batch, transaction);
  for (const { personId, delivery } of recipients) {
    const outcome = await processRecipient(port, { tenant, campaign, step, personId, now, delivery, actionKey: actionKeyOf(campaign.id, step.id, personId) }, policy, transaction);
    totals[outcome.toLowerCase()] += 1;
  }
  // Fecha só quando ninguém ficou sem entrega E nenhuma entrega está aberta (RETRY/UNKNOWN voltam em next_attempt_at; o step segue SCHEDULED até lá).
  if (await deliveries.stepComplete(campaign.id, step.id, tenant, transaction)) {
    if (await finishStep(campaign, step, tenant, transaction) === 'SENT') totals.stepsDone += 1; else totals.skipped += 1;
  }
}

/**
 * Dispara os steps SCHEDULED cujo `starts_at + offset_minutes <= agora`, de campanhas RUNNING (um envio por step e destinatário,
 * idempotente por action_key). Sem porta de envio registrada nada é disparado (os steps continuam SCHEDULED e entram em `deferred`).
 */
async function dispatchDueSteps(tenant, transaction, now) {
  const totals = { sent: 0, blocked: 0, failed: 0, skipped: 0, stepsDone: 0, deferred: 0, retry: 0, unknown: 0 };
  totals.blocked += await countBlocked(tenant, now, transaction);
  const due = await dueSteps(tenant, now, transaction);
  const port = getCampaignSendPort();
  if (!port) { totals.deferred = due.length; return totals; }
  // Entregas abertas de step que fechou (campanha encerrada, step pulado): RETRY cancelada, UNKNOWN só reconciliado (nunca reenviado).
  totals.closing = await closeOpenOfClosedSteps(tenant, { port, now, sequelize }, transaction);
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
