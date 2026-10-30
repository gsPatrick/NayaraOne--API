'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { createFeedbackCase } = require('../../../../crm/feedbackCases.service');
const { updateOpportunity } = require('../../../../crm/opportunity.service');
const receipt = require('./receipt');

/** OPEN_CASE -> serviço de ocorrências (feedback_case) do CRM; o recibo guarda a action_key. */
async function openCase(ctx) {
  const { def, subject, tenant, transaction } = ctx;
  if (!subject || !def.description) throw AppError.badRequest('A ocorrência precisa de uma pessoa e de uma descrição.', 'MKT_ACTION_INVALID');
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const created = await createFeedbackCase({
    groupId: tenant.groupId, companyId: tenant.companyId, personId: subject.id, type: def.caseType || 'COMPLAINT', description: String(def.description), severity: def.severity,
    assignedToUserId: def.assigneeUserId || ctx.flow.ownerUserId || null,
  }, ctx.flow.ownerUserId || null, transaction);
  const row = created.feedbackCase || created;
  await receipt.setDestination(ctx, row.id);
  return { status: 'OK', providerRef: row.id };
}

/** UPDATE_CRM_STAGE_TAG -> serviço da oportunidade do CRM: etapa (`stage`) e etiqueta de temperatura (`temperature`) da oportunidade mais recente da pessoa. */
async function updateStageTag(ctx) {
  const { def, subject, tenant, transaction } = ctx;
  if (!subject || (!def.stage && !def.temperature)) throw AppError.badRequest('Informe a pessoa e a etapa ou a etiqueta.', 'MKT_ACTION_INVALID');
  if ((await receipt.claim(ctx)).replay) return receipt.replayed(ctx);
  const [opportunity] = await sequelize.query('SELECT id FROM crm.opportunities WHERE company_id = :c AND person_id = :p AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
    { replacements: { c: tenant.companyId, p: subject.id }, transaction, type: QueryTypes.SELECT });
  if (!opportunity) return { status: 'SKIPPED', errorCode: 'MKT_NO_OPPORTUNITY' };
  const payload = { ...(def.stage ? { stage: def.stage } : {}), ...(def.temperature ? { temperature: def.temperature } : {}), ...(def.nextAction ? { nextAction: def.nextAction, nextActionDueAt: def.nextActionDueAt } : {}) };
  await updateOpportunity(opportunity.id, payload, ctx.flow.ownerUserId || null, transaction);
  await receipt.setDestination(ctx, opportunity.id);
  return { status: 'OK', providerRef: opportunity.id };
}

module.exports = { openCase, updateStageTag };
