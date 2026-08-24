'use strict';

const { Opportunity, Person, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { CLOSED_STAGES, assertNextActionWhenActive } = require('./opportunityNextAction.validator');
const { publishOpportunityCreated, publishOpportunityStageChanged } = require('./opportunityEvents.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const TEMPERATURES = ['COLD', 'WARM', 'HOT'];

// CRUD puro de Opportunity — a regra de "nextAction obrigatório em estágio ativo" vive em
// opportunityNextAction.validator.js e a publicação de domain events de stage change vive em
// opportunityEvents.service.js; este service apenas orquestra as duas coisas ao redor do CRUD.

async function createOpportunity(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    personId,
    propertyId,
    ownerUserId,
    stage,
    temperature,
    expectedValue,
    nextAction,
    nextActionDueAt,
  } = payload;

  if (!groupId || !companyId || !personId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "personId" são obrigatórios.', 'OPPORTUNITY_VALIDATION');
  }

  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa (cliente/lead) não encontrada.', 'PERSON_NOT_FOUND');

  if (propertyId) {
    const property = await Property.findByPk(propertyId, { transaction });
    if (!property) throw AppError.notFound('Imóvel de interesse não encontrado.', 'PROPERTY_NOT_FOUND');
  }

  const normalizedStage = stage ? String(stage).toUpperCase() : 'NEW';
  if (temperature && !TEMPERATURES.includes(String(temperature).toUpperCase())) {
    throw AppError.badRequest(`O campo "temperature" deve ser um de: ${TEMPERATURES.join(', ')}.`, 'OPPORTUNITY_VALIDATION');
  }

  assertNextActionWhenActive({ stage: normalizedStage, nextAction, nextActionDueAt });

  const opportunity = await Opportunity.create(
    {
      groupId,
      companyId,
      personId,
      propertyId: propertyId || null,
      ownerUserId: ownerUserId || null,
      stage: normalizedStage,
      temperature: temperature ? String(temperature).toUpperCase() : null,
      expectedValue: expectedValue !== undefined ? expectedValue : null,
      nextAction: nextAction || null,
      nextActionDueAt: nextActionDueAt || null,
      closedAt: CLOSED_STAGES.includes(normalizedStage) ? new Date() : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOpportunityCreated(opportunity, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'opportunity.create',
      entityType: 'Opportunity',
      entityId: opportunity.id,
      afterJson: opportunity.toJSON(),
      reason: `Oportunidade criada para "${person.legalName || personId}" na etapa "${normalizedStage}".`,
    },
    transaction
  );

  return opportunity;
}

async function listOpportunities(transaction, filters = {}) {
  const where = {};
  if (filters.stage) where.stage = String(filters.stage).toUpperCase();
  if (filters.personId) where.personId = filters.personId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return Opportunity.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOpportunity(id, transaction) {
  const opportunity = await Opportunity.findByPk(id, { transaction });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  return opportunity;
}

async function updateOpportunity(id, payload, actorUserId, transaction) {
  const opportunity = await getOpportunity(id, transaction);
  const previousStage = opportunity.stage;
  const beforeJson = opportunity.toJSON();
  const { stage, temperature, expectedValue, nextAction, nextActionDueAt, lostReason, ownerUserId } = payload;

  const nextStage = stage !== undefined ? String(stage).toUpperCase() : opportunity.stage;
  const nextNextAction = nextAction !== undefined ? nextAction : opportunity.nextAction;
  const nextNextActionDueAt = nextActionDueAt !== undefined ? nextActionDueAt : opportunity.nextActionDueAt;

  assertNextActionWhenActive({ stage: nextStage, nextAction: nextNextAction, nextActionDueAt: nextNextActionDueAt });

  if (temperature !== undefined) {
    if (temperature && !TEMPERATURES.includes(String(temperature).toUpperCase())) {
      throw AppError.badRequest(`O campo "temperature" deve ser um de: ${TEMPERATURES.join(', ')}.`, 'OPPORTUNITY_VALIDATION');
    }
    opportunity.temperature = temperature ? String(temperature).toUpperCase() : null;
  }
  if (ownerUserId !== undefined) opportunity.ownerUserId = ownerUserId;
  if (expectedValue !== undefined) opportunity.expectedValue = expectedValue;
  if (nextAction !== undefined) opportunity.nextAction = nextAction;
  if (nextActionDueAt !== undefined) opportunity.nextActionDueAt = nextActionDueAt;
  if (lostReason !== undefined) opportunity.lostReason = lostReason;
  if (stage !== undefined) {
    opportunity.stage = nextStage;
    if (CLOSED_STAGES.includes(nextStage) && !opportunity.closedAt) {
      opportunity.closedAt = new Date();
    }
    if (!CLOSED_STAGES.includes(nextStage)) {
      opportunity.closedAt = null;
    }
  }

  opportunity.updatedBy = actorUserId || null;
  await opportunity.save({ transaction });

  if (stage !== undefined && nextStage !== previousStage) {
    await publishOpportunityStageChanged(opportunity, previousStage, transaction);
  }

  const stageChanged = stage !== undefined && nextStage !== previousStage;
  await registrarAuditoria(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      actorUserId,
      action: stageChanged ? 'opportunity.stage_change' : 'opportunity.update',
      entityType: 'Opportunity',
      entityId: opportunity.id,
      beforeJson,
      afterJson: opportunity.toJSON(),
      reason: stageChanged
        ? `Oportunidade movida de "${previousStage}" para "${nextStage}".`
        : 'Oportunidade atualizada.',
    },
    transaction
  );

  return opportunity;
}

async function deleteOpportunity(id, actorUserId, transaction) {
  const opportunity = await getOpportunity(id, transaction);
  opportunity.deletedBy = actorUserId || null;
  await opportunity.save({ transaction });
  await opportunity.destroy({ transaction });
  return { id };
}

module.exports = {
  createOpportunity,
  listOpportunities,
  getOpportunity,
  updateOpportunity,
  deleteOpportunity,
};
