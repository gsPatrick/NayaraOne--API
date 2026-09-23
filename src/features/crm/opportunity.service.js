'use strict';

const { Opportunity, Person, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { CLOSED_STAGES, assertNextActionWhenActive } = require('./opportunityNextAction.validator');
const { assertOutcomeReason } = require('./opportunityOutcomeReason.validator');
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
    wonReason,
    lostReason,
    withdrawnReason,
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
  // M3-12: se já nasce num estágio de desfecho (CLOSED_WON/CLOSED_LOST/WITHDRAWN), o motivo
  // estruturado é obrigatório e precisa pertencer ao enum daquele desfecho.
  const outcome = assertOutcomeReason({ stage: normalizedStage, wonReason, lostReason, withdrawnReason });

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
      wonReason: outcome && outcome.field === 'wonReason' ? outcome.value : null,
      lostReason: outcome && outcome.field === 'lostReason' ? outcome.value : null,
      withdrawnReason: outcome && outcome.field === 'withdrawnReason' ? outcome.value : null,
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

async function getOpportunity(id, transaction, { lock = false } = {}) {
  // FIX (homologação 23/09/2026 — auditoria adversarial de corrida): updateOpportunity (usada
  // pela mudança de estágio no Kanban) lia a oportunidade sem lock pessimista. Duas transições
  // concorrentes no mesmo card (drag-and-drop em duas abas) podiam basear-se ambas na mesma
  // leitura obsoleta e a segunda a commitar sobrescrevia silenciosamente a transição da primeira,
  // perdendo a passagem por um estágio intermediário na trilha de auditoria. Quem chama dentro de
  // um fluxo de escrita passa `{ lock: true }` para travar a linha (SELECT ... FOR UPDATE).
  const opportunity = await Opportunity.findByPk(id, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  return opportunity;
}

async function updateOpportunity(id, payload, actorUserId, transaction) {
  const opportunity = await getOpportunity(id, transaction, { lock: true });
  const previousStage = opportunity.stage;
  const beforeJson = opportunity.toJSON();
  const { stage, temperature, expectedValue, nextAction, nextActionDueAt, lostReason, wonReason, withdrawnReason, ownerUserId } =
    payload;

  const nextStage = stage !== undefined ? String(stage).toUpperCase() : opportunity.stage;
  const nextNextAction = nextAction !== undefined ? nextAction : opportunity.nextAction;
  const nextNextActionDueAt = nextActionDueAt !== undefined ? nextActionDueAt : opportunity.nextActionDueAt;

  assertNextActionWhenActive({ stage: nextStage, nextAction: nextNextAction, nextActionDueAt: nextNextActionDueAt });

  // M3-12: ao MOVER para um estágio de desfecho, exige o motivo estruturado. O motivo pode
  // vir no próprio payload ou já estar gravado (ex.: reeditar uma oportunidade já fechada sem
  // reenviar o motivo) — por isso o fallback para o valor atual da entidade.
  const outcome = assertOutcomeReason({
    stage: nextStage,
    wonReason: wonReason !== undefined ? wonReason : opportunity.wonReason,
    lostReason: lostReason !== undefined ? lostReason : opportunity.lostReason,
    withdrawnReason: withdrawnReason !== undefined ? withdrawnReason : opportunity.withdrawnReason,
  });

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
  if (wonReason !== undefined) opportunity.wonReason = wonReason;
  if (withdrawnReason !== undefined) opportunity.withdrawnReason = withdrawnReason;
  // Grava o motivo já NORMALIZADO (upper case) do desfecho validado — garante que o painel
  // (M3-17) agregue sempre sobre os mesmos valores canônicos.
  if (outcome) opportunity[outcome.field] = outcome.value;
  if (stage !== undefined) {
    opportunity.stage = nextStage;
    if (CLOSED_STAGES.includes(nextStage) && !opportunity.closedAt) {
      opportunity.closedAt = new Date();
    }
    if (!CLOSED_STAGES.includes(nextStage)) {
      // FIX (homologação 23/09/2026 — teste adversarial de Kanban): reabrir uma oportunidade
      // fechada (ex.: Perdido -> Em Contato) já zerava `closedAt`, mas mantinha `wonReason`/
      // `lostReason` preenchidos do fechamento anterior — distorcendo o painel de "motivo mais
      // comum" (M3-17), que passava a contar motivo de um desfecho que não existe mais. Agora
      // reabrir também limpa os dois campos, a menos que o próprio payload esteja setando um
      // desfecho novo neste mesmo request (caso `outcome` acima já vá sobrescrever em seguida).
      opportunity.closedAt = null;
      if (!outcome || outcome.field !== 'wonReason') opportunity.wonReason = null;
      if (!outcome || outcome.field !== 'lostReason') opportunity.lostReason = null;
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
