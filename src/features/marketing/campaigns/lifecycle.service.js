'use strict';

const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const campaignRepo = require('./campaigns.repository');
const { assertTransition } = require('./campaigns.stateMachine');
const { countResult, computeAttainment } = require('./campaigns.result');
const { run } = require('./campaigns.repository');
const { dispatchDueSteps } = require('./stepDispatcher');

const ENTITY = 'marketing.campaign';

async function emit(eventType, row, tenant, payload, transaction) {
  await publishDomainEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'MarketingCampaign', aggregateId: row.id, eventType,
    payload: { campaignId: row.id, code: row.code, ...payload }, idempotencyKey: `${eventType}:${row.id}`,
  }, transaction);
}

/** SCHEDULED -> RUNNING quando starts_at <= agora. Idempotente: relê a linha travada; quem perdeu a corrida não faz nada. */
async function startCampaign(id, tenant, now, transaction) {
  const row = await campaignRepo.findById(id, tenant, transaction, { lock: true });
  if (!row || row.status !== 'SCHEDULED' || new Date(row.starts_at) > now) return false;
  assertTransition(row.status, 'RUNNING');
  await campaignRepo.update(id, { status: 'RUNNING' }, null, transaction);
  await emit('marketing.campaign.started', row, tenant, { startedAt: now.toISOString(), startsAt: new Date(row.starts_at).toISOString() }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.campaign.start', entityType: ENTITY, entityId: id,
    beforeJson: { status: 'SCHEDULED' }, afterJson: { status: 'RUNNING' }, reason: `Campanha ${row.code} iniciada automaticamente no horário agendado.`,
  }, transaction);
  return true;
}

/** Encerrada não continua: steps pendentes e jobs de publicação PENDING da campanha vão a CANCELLED (motivo CAMPAIGN_ENDED). */
async function cancelPendingWork(row, tenant, transaction) {
  const steps = await run(
    `UPDATE marketing.campaign_steps SET status = 'CANCELLED', status_reason = 'CAMPAIGN_ENDED', updated_at = now()
      WHERE campaign_id = :id AND company_id = :companyId AND deleted_at IS NULL AND status IN ('PLANNED','SCHEDULED') RETURNING id`,
    { id: row.id, companyId: tenant.companyId }, transaction
  );
  const jobs = await run(
    `UPDATE marketing.publication_jobs SET status = 'CANCELLED', last_error_code = 'CAMPAIGN_ENDED', updated_at = now()
      WHERE company_id = :companyId AND status = 'PENDING' AND deleted_at IS NULL AND content_version_id IN (
        SELECT v.id FROM marketing.content_versions v JOIN marketing.content_items i ON i.id = v.content_item_id AND i.company_id = v.company_id
         WHERE i.company_id = :companyId AND (i.campaign_id = :id
            OR i.id IN (SELECT content_item_id FROM marketing.campaign_steps WHERE campaign_id = :id AND company_id = :companyId AND content_item_id IS NOT NULL)))
      RETURNING id`,
    { id: row.id, companyId: tenant.companyId }, transaction
  );
  return { steps: steps.length, jobs: jobs.length };
}

/** RUNNING -> ENDED quando ends_at <= agora: calcula o resultado, cancela o que estava pendente e emite marketing.campaign.ended. */
async function endCampaign(id, tenant, now, transaction) {
  const row = await campaignRepo.findById(id, tenant, transaction, { lock: true });
  if (!row || row.status !== 'RUNNING' || new Date(row.ends_at) > now) return false;
  assertTransition(row.status, 'ENDED');
  const resultValue = await countResult(row, tenant, transaction);
  const updated = await campaignRepo.update(id, { status: 'ENDED', resultValue }, null, transaction);
  const cancelled = await cancelPendingWork(row, tenant, transaction);
  const attainment = computeAttainment(resultValue, updated.target_value);
  await emit('marketing.campaign.ended', row, tenant, {
    endedAt: now.toISOString(), objectiveMetric: row.objective_metric, targetValue: Number(updated.target_value), resultValue, attainment,
    costActual: Number(updated.cost_actual), cancelledSteps: cancelled.steps, cancelledJobs: cancelled.jobs,
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: null, action: 'marketing.campaign.end', entityType: ENTITY, entityId: id,
    beforeJson: { status: 'RUNNING', resultValue: row.result_value }, afterJson: { status: 'ENDED', resultValue, attainment, ...cancelled },
    reason: `Campanha ${row.code} encerrada automaticamente: resultado ${resultValue} de ${Number(updated.target_value)}.`,
  }, transaction);
  return true;
}

/** Cada campanha roda em savepoint: o erro de uma não desfaz nem trava as outras. */
async function each(ids, action, transaction, label) {
  const done = []; const failed = [];
  for (const { id } of ids) {
    try {
      if (await sequelize.transaction({ transaction }, (inner) => action(id, inner))) done.push(id);
    } catch (err) {
      failed.push(id);
      logger.error({ campaignId: id, err: err.message }, `marketing.campaign.${label}.failed`);
    }
  }
  return { done, failed };
}

/**
 * Uma rodada do campaignLifecycleJob para UMA empresa (sessão já com o tenant): inicia as vencidas, encerra as vencidas e dispara
 * os steps devidos. `now` é injetável (testes); o horário é sempre comparado como instante, sem depender do fuso do servidor.
 */
async function runLifecycleTick(tenant, transaction, now = new Date()) {
  const toStart = await campaignRepo.dueToStart(tenant, now, transaction);
  const started = await each(toStart, (id, inner) => startCampaign(id, tenant, now, inner), transaction, 'start');
  const toEnd = await campaignRepo.dueToEnd(tenant, now, transaction);
  const ended = await each(toEnd, (id, inner) => endCampaign(id, tenant, now, inner), transaction, 'end');
  const dispatch = await dispatchDueSteps(tenant, transaction, now);
  return { started: started.done, ended: ended.done, failed: [...started.failed, ...ended.failed], dispatch };
}

module.exports = { startCampaign, endCampaign, runLifecycleTick };
