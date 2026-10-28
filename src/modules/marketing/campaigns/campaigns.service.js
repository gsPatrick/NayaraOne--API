'use strict';

const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const campaignRepo = require('./campaigns.repository');
const audienceRepo = require('./audience.repository');
const audienceService = require('./audience.service');
const stepsRepo = require('./steps.repository');
const stepsService = require('./steps.service');
const { scheduleDraft, missingItems } = require('./schedule.service');
const { assertEditable } = require('./campaigns.stateMachine');
const { parseBody, isUuid } = require('./campaigns.validation');
const { parseInstant } = require('./campaigns.time');
const { carriesNoData, matchesStored } = require('./campaigns.replay');
const { campaignDto } = require('./campaigns.dto');
const { campaignNotFound, codeDuplicate, validation, ownerInvalid, campaignIncomplete, campaignNotEditable } = require('./campaigns.errors');

const ENTITY = 'marketing.campaign';
const MIN_OBJECTIVE = 10;

async function loadDto(id, tenant, transaction) {
  const row = await campaignRepo.findById(id, tenant, transaction);
  if (!row) throw campaignNotFound();
  const [audiences, steps] = await Promise.all([audienceRepo.listAudiences(id, tenant, transaction), stepsRepo.listSteps(id, tenant, transaction)]);
  const size = row.status === 'DRAFT' ? null : await audienceRepo.countDistinctMembers(id, tenant, transaction);
  return campaignDto(row, audiences, steps, size);
}

/** Consulta de MKT-009 (GET /marketing/campaigns/:id): objetivo, público (só a contagem), custo e resultado. */
async function getCampaign(tenant, id, transaction) {
  if (!isUuid(id)) throw campaignNotFound();
  return loadDto(id, tenant, transaction);
}

/** Datas informadas (sem fuso = America/Sao_Paulo). */
async function parseDates(fields, tenant, transaction) {
  return {
    startsAt: fields.startsAt === undefined ? undefined : await parseInstant(fields.startsAt, 'startsAt', tenant, transaction),
    endsAt: fields.endsAt === undefined ? undefined : await parseInstant(fields.endsAt, 'endsAt', tenant, transaction),
  };
}

function assertDraftRanges(v) {
  if (v.target_value !== null && !(Number(v.target_value) > 0)) throw validation('A meta da campanha deve ser maior que zero.', { field: 'targetValue' });
  if (v.budget_amount !== null && Number(v.budget_amount) < 0) throw validation('O orçamento da campanha não pode ser negativo.', { field: 'budgetAmount' });
  if (v.budget_amount !== null && Number(v.budget_amount) === 0 && !(v.budget_justification || '').trim()) {
    throw validation('Informe a justificativa do orçamento zerado da campanha.', { field: 'budgetJustification' });
  }
  if (v.starts_at && v.ends_at && !(new Date(v.ends_at) > new Date(v.starts_at))) throw validation('O fim da campanha deve ser depois do início.', { field: 'endsAt' });
}

function assertObjective(objective) {
  if (typeof objective !== 'string' || objective.trim().length < MIN_OBJECTIVE) {
    throw validation('Informe o objetivo da campanha (mínimo 10 caracteres).', { field: 'objective' });
  }
}

async function resolveOwner(input, row, ctx, transaction) {
  if (input.fields.ownerUserId === undefined) return row ? row.owner_user_id : ctx.actor;
  if (!(await campaignRepo.ownerBelongsToCompany(input.fields.ownerUserId, ctx.tenant, transaction))) throw ownerInvalid();
  return input.fields.ownerUserId;
}

/** Aplica o corpo ao rascunho (campos, audiências e steps) e, com `schedule`, agenda na mesma transação. */
async function applyToDraft(row, input, ctx, transaction) {
  const { tenant, actor, now } = ctx;
  const f = input.fields;
  const dates = await parseDates(f, tenant, transaction);
  if (f.objective !== undefined) assertObjective(f.objective);
  if (f.name !== undefined && !f.name) throw validation('Informe o nome da campanha.', { field: 'name' });

  const channels = f.channels !== undefined ? f.channels : (input.steps ? [...new Set(input.steps.map((s) => s.channel))] : row.channels);
  const patch = {
    name: f.name, objective: f.objective, objectiveMetric: f.objectiveMetric, targetValue: f.targetValue, budgetAmount: f.budgetAmount,
    budgetJustification: f.budgetJustification, channels, startsAt: dates.startsAt, endsAt: dates.endsAt,
    ownerUserId: await resolveOwner(input, row, ctx, transaction),
  };
  const virtual = {
    ...row,
    ...Object.fromEntries(Object.entries({
      objective_metric: patch.objectiveMetric, target_value: patch.targetValue, budget_amount: patch.budgetAmount, budget_justification: patch.budgetJustification,
      starts_at: patch.startsAt, ends_at: patch.endsAt, owner_user_id: patch.ownerUserId,
    }).filter(([, v]) => v !== undefined)),
  };

  if (input.audiences !== null) await audienceService.assertAudiencesInCompany(input.audiences, tenant, transaction);
  if (input.schedule) {
    const audCount = input.audiences ? input.audiences.length : (await audienceRepo.listAudiences(row.id, tenant, transaction)).length;
    const stepCount = input.steps ? input.steps.length : (await stepsRepo.listSteps(row.id, tenant, transaction)).length;
    const missing = missingItems(virtual, audCount, stepCount, now);
    if (missing.length > 0) throw campaignIncomplete(missing);
  } else {
    assertDraftRanges(virtual);
  }

  if (input.steps !== null) {
    await stepsService.assertStepsReferences(input.steps, channels, tenant, transaction);
    await stepsRepo.replaceSteps(row.id, input.steps, tenant, actor, transaction);
  }
  if (input.audiences !== null) await audienceService.saveDraftAudiences(row.id, input.audiences, tenant, actor, transaction);
  const updated = await campaignRepo.update(row.id, patch, actor, transaction);

  if (input.schedule) {
    await scheduleDraft(updated, ctx, transaction);
  } else if (ctx.auditUpdate) {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.campaign.update', entityType: ENTITY, entityId: row.id,
      beforeJson: { status: row.status, name: row.name, objectiveMetric: row.objective_metric, targetValue: row.target_value, budgetAmount: row.budget_amount },
      afterJson: { status: updated.status, name: updated.name, objectiveMetric: updated.objective_metric, targetValue: updated.target_value, budgetAmount: updated.budget_amount },
      reason: `Rascunho da campanha ${row.code} atualizado.`,
    }, transaction);
  }
  return loadDto(row.id, tenant, transaction);
}

async function createDraft(input, ctx, transaction) {
  const { tenant, actor } = ctx;
  const f = input.fields;
  if (!f.name) throw validation('Informe o nome da campanha.', { field: 'name' });
  assertObjective(f.objective);
  const code = f.code || `CMP-${new Date().getUTCFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  if (await campaignRepo.codeExists(code, tenant, transaction)) throw codeDuplicate(code);
  const ownerUserId = await resolveOwner(input, null, ctx, transaction);
  const row = await campaignRepo.insertDraft({ tenant, code, name: f.name, objective: f.objective, ownerUserId, actor }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor, action: 'marketing.campaign.create', entityType: ENTITY, entityId: row.id,
    beforeJson: null, afterJson: { code, name: f.name, status: 'DRAFT', ownerUserId }, reason: `Campanha ${code} criada em rascunho.`,
  }, transaction);
  return { created: true, replay: false, campaign: await applyToDraft(row, input, { ...ctx, auditUpdate: false }, transaction) };
}

async function completeExisting(input, ctx, transaction) {
  const { tenant } = ctx;
  const row = await campaignRepo.findById(input.campaignId, tenant, transaction, { lock: true });
  if (!row) throw campaignNotFound();
  if (row.status === 'SCHEDULED' && input.schedule) {
    const [audiences, steps] = await Promise.all([audienceRepo.listAudiences(row.id, tenant, transaction), stepsRepo.listSteps(row.id, tenant, transaction)]);
    const dates = await parseDates(input.fields, tenant, transaction);
    if (carriesNoData(input) || matchesStored(row, input, audiences, steps, dates)) {
      return { created: false, replay: true, campaign: await loadDto(row.id, tenant, transaction) };
    }
    throw campaignNotEditable(row.status);
  }
  assertEditable(row.status);
  return { created: false, replay: false, campaign: await applyToDraft(row, input, { ...ctx, auditUpdate: true }, transaction) };
}

/**
 * POST /marketing/campaigns (M9-D412). Sem `campaignId` cria a campanha em DRAFT (ou já agenda, com `schedule:true`); com
 * `campaignId` completa o rascunho e, com `schedule:true`, agenda. Atômico: a chamada recusada não deixa nada gravado (savepoint).
 * Devolve { created, replay, campaign }.
 */
async function saveCampaign(tenant, actor, rawBody, { permissions = [] } = {}, transaction, { now = new Date() } = {}) {
  const input = parseBody(rawBody);
  const ctx = { tenant, actor, permissions, now };
  return sequelize.transaction({ transaction }, async (inner) => (input.campaignId ? completeExisting(input, ctx, inner) : createDraft(input, ctx, inner)));
}

module.exports = { saveCampaign, getCampaign };
