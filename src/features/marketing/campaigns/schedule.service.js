'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const campaignRepo = require('./campaigns.repository');
const audienceRepo = require('./audience.repository');
const audienceService = require('./audience.service');
const stepsRepo = require('./steps.repository');
const stepsService = require('./steps.service');
const { assertTransition } = require('./campaigns.stateMachine');
const { campaignIncomplete } = require('./campaigns.errors');
const { assertMassSendAllowed } = require('../marketing.guards');
const { assertSchedulingNotPaused } = require('../degradation.guard');

/**
 * Itens de MKT-009 que faltam para agendar (lista vazia = campanha completa). `now` é o relógio da operação: o início precisa
 * estar no futuro. O objetivo (>= 10 caracteres) nunca entra aqui: é checado desde o rascunho (400 MKT_CAMPAIGN_VALIDATION).
 */
function missingItems(row, audienceCount, stepCount, now) {
  const missing = [];
  if (!row.objective_metric) missing.push('objectiveMetric');
  if (row.target_value === null || !(Number(row.target_value) > 0)) missing.push('targetValue');
  if (row.budget_amount === null || Number(row.budget_amount) < 0) missing.push('budgetAmount');
  else if (Number(row.budget_amount) === 0 && !(row.budget_justification || '').trim()) missing.push('budgetJustification');
  if (audienceCount === 0) missing.push('audiences');
  if (stepCount === 0) missing.push('steps');
  const startsAt = row.starts_at ? new Date(row.starts_at) : null;
  const endsAt = row.ends_at ? new Date(row.ends_at) : null;
  if (!startsAt || !(startsAt.getTime() > now.getTime())) missing.push('startsAt');
  if (!endsAt || !startsAt || !(endsAt.getTime() > startsAt.getTime())) missing.push('endsAt');
  if (!row.owner_user_id) missing.push('ownerUserId');
  return missing;
}

/**
 * DRAFT -> SCHEDULED na mesma transação: itens obrigatórios (422 MKT_CAMPAIGN_INCOMPLETE), steps com template publicado e conteúdo
 * aprovado, teto de envio em massa sobre o tamanho congelado (M9-D433), congelamento e materialização do público, steps PLANNED ->
 * SCHEDULED, status e auditoria. `row` já está travada (FOR UPDATE) e atualizada com o corpo da chamada.
 */
async function scheduleDraft(row, ctx, transaction) {
  const { tenant, actor, permissions, now } = ctx;
  assertTransition(row.status, 'SCHEDULED');
  await assertSchedulingNotPaused(tenant, transaction); // M9-D863: passo PAUSE_MARKETING_CAMPAIGNS
  const audiences = await audienceRepo.listAudiences(row.id, tenant, transaction);
  const steps = await stepsRepo.listSteps(row.id, tenant, transaction);
  const missing = missingItems(row, audiences.length, steps.length, now);
  if (missing.length > 0) throw campaignIncomplete(missing);
  await stepsService.assertStepsApproved(steps, tenant, transaction);

  const recipients = await audienceRepo.countDistinctPersons(audiences, tenant, now, transaction);
  const mass = await assertMassSendAllowed({ recipients, permissions, tenant, transaction });

  const frozen = await audienceService.freezeAll(row.id, tenant, actor, now, transaction);
  await stepsRepo.scheduleSteps(row.id, tenant, actor, transaction);
  const updated = await campaignRepo.update(row.id, { status: 'SCHEDULED', ...(mass.massConfirmed ? { massConfirmedBy: actor, massConfirmedAt: now } : {}) }, actor, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.campaign.schedule', entityType: 'marketing.campaign',
    entityId: row.id, beforeJson: { status: row.status }, afterJson: { status: 'SCHEDULED', massConfirmed: mass.massConfirmed, audienceSize: frozen, steps: steps.length, startsAt: updated.starts_at, endsAt: updated.ends_at },
    reason: `Campanha ${row.code} agendada com ${frozen} destinatário(s) e ${steps.length} step(s).`,
  }, transaction);
  return { row: updated, audienceSize: frozen };
}

module.exports = { missingItems, scheduleDraft };
