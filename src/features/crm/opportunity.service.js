'use strict';

const { Opportunity, Person, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { CLOSED_STAGES, assertNextActionWhenActive } = require('./opportunityNextAction.validator');
const { normalizeStage, canonicalStage, DEFAULT_STAGE, isWithdrawalRequest } = require('./opportunityStages');
const { resolveOutcomeReason } = require('./opportunityOutcomeReason.validator');
const { resolveOwnerUserId, assertResponsibleUser } = require('./crmUsers');
const { cancelPendingTasks } = require('./opportunityTaskCancellation');
const {
  publishOpportunityCreated,
  publishOpportunityStageChanged,
  publishOpportunityCreatedEvent,
  publishOpportunityWon,
  publishOpportunityLost,
} = require('./opportunityEvents.service');
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

  const normalizedStage = stage !== undefined && stage !== null && stage !== '' ? normalizeStage(stage) : DEFAULT_STAGE;
  if (temperature && !TEMPERATURES.includes(String(temperature).toUpperCase())) {
    throw AppError.badRequest(`O campo "temperature" deve ser um de: ${TEMPERATURES.join(', ')}.`, 'OPPORTUNITY_VALIDATION');
  }

  assertNextActionWhenActive({ stage: normalizedStage, nextAction, nextActionDueAt });
  const tenant = { groupId, companyId };
  // M3-12: se já nasce num estágio de desfecho (WON/LOST), o motivo estruturado é obrigatório e precisa estar na lista da empresa.
  const outcome = await resolveOutcomeReason(
    { stage: normalizedStage, entering: true, withdrawal: isWithdrawalRequest(stage), input: { wonReason, lostReason, withdrawnReason } },
    tenant,
    transaction
  );
  // Guia §7 assertResponsibleUser / CRMX-006: toda oportunidade tem responsável (DI-M3CA-1).
  const resolvedOwnerUserId = await resolveOwnerUserId({ ownerUserId, actorUserId }, tenant, transaction);

  const opportunity = await Opportunity.create(
    {
      groupId,
      companyId,
      personId,
      propertyId: propertyId || null,
      ownerUserId: resolvedOwnerUserId,
      stage: normalizedStage,
      temperature: temperature ? String(temperature).toUpperCase() : null,
      expectedValue: expectedValue !== undefined ? expectedValue : null,
      nextAction: nextAction || null,
      nextActionDueAt: nextActionDueAt || null,
      wonReason: outcome && outcome.wonReason ? outcome.wonReason : null,
      lostReason: outcome && outcome.lostReason ? outcome.lostReason : null,
      withdrawnReason: outcome && outcome.withdrawnReason ? outcome.withdrawnReason : null,
      closedAt: CLOSED_STAGES.includes(normalizedStage) ? new Date() : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOpportunityCreated(opportunity, transaction);
  await publishOpportunityCreatedEvent(opportunity, transaction);
  if (opportunity.stage === 'WON') await publishOpportunityWon(opportunity, transaction);
  if (opportunity.stage === 'LOST') await publishOpportunityLost(opportunity, transaction);

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

  // M9-D431: origem do lead com rastreio (formulário, WhatsApp, ligação). Referência de campanha/link inválida não impede a criação:
  // o lead nasce sem atribuição (attribution_valid = false).
  if (payload.leadSource) {
    const { service: tracking } = require('../../features/marketing/tracking'); // require tardio: evita ciclo de carga entre o CRM e o Marketing
    await tracking.recordLeadSource(
      { tenant: { groupId, companyId }, actor: actorUserId, opportunityId: opportunity.id, leadSource: payload.leadSource,
        campaignId: payload.campaignId, trackingLinkId: payload.trackingLinkId, clickAt: payload.clickAt },
      transaction
    );
  }

  return opportunity;
}

// CRM-TS-012 / item 17 do Caderno (seção 18, "Antifraude e segurança": "Corretor visualizar
// carteira alheia — Escopo conforme política de equipe"): sem `ownerScope`, o comportamento é
// o de sempre (ver tudo) — quem decide o escopo é o CONTROLLER, a partir de
// `req.auth.permissions` (ver crm.controller.js). Dois valores possíveis:
//   - 'OWN'  → só oportunidades onde ownerUserId === ownerScope.userId.
//   - 'ALL'  (ou ausente) → sem filtro extra, vê tudo da empresa (fallback sem regressão para
//     quem só tem a permissão legada `crm:opportunities:read`, sem nenhuma das duas novas
//     permissões de escopo granular `crm:opportunities:read:own`/`:all`).
async function listOpportunities(transaction, filters = {}) {
  const where = {};
  if (filters.stage) where.stage = canonicalStage(filters.stage);
  if (filters.personId) where.personId = filters.personId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.ownerScope && filters.ownerScope.mode === 'OWN') {
    where.ownerUserId = filters.ownerScope.userId;
  }
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

  const nextStage = stage !== undefined ? normalizeStage(stage) : opportunity.stage;
  const nextNextAction = nextAction !== undefined ? nextAction : opportunity.nextAction;
  const nextNextActionDueAt = nextActionDueAt !== undefined ? nextActionDueAt : opportunity.nextActionDueAt;

  assertNextActionWhenActive({ stage: nextStage, nextAction: nextNextAction, nextActionDueAt: nextNextActionDueAt });

  const tenant = { groupId: opportunity.groupId, companyId: opportunity.companyId };
  // M3-12 / CRM-TS-008: ao ENTRAR num desfecho o motivo tem de vir no pedido (o de um desfecho anterior não fecha de novo);
  // reeditar a oportunidade que já está no desfecho mantém o motivo gravado.
  const outcome = await resolveOutcomeReason(
    {
      stage: nextStage,
      entering: nextStage !== previousStage,
      withdrawal: stage !== undefined && isWithdrawalRequest(stage),
      input: { wonReason, lostReason, withdrawnReason },
      current: { wonReason: opportunity.wonReason, lostReason: opportunity.lostReason, withdrawnReason: opportunity.withdrawnReason },
    },
    tenant,
    transaction
  );

  if (temperature !== undefined) {
    if (temperature && !TEMPERATURES.includes(String(temperature).toUpperCase())) {
      throw AppError.badRequest(`O campo "temperature" deve ser um de: ${TEMPERATURES.join(', ')}.`, 'OPPORTUNITY_VALIDATION');
    }
    opportunity.temperature = temperature ? String(temperature).toUpperCase() : null;
  }
  // CRMX-006: o responsável troca, mas não some (nulo ou vazio é recusado); o novo precisa ser usuário ativo da empresa.
  if (ownerUserId !== undefined) opportunity.ownerUserId = await assertResponsibleUser(ownerUserId, opportunity.companyId, transaction);
  if (expectedValue !== undefined) opportunity.expectedValue = expectedValue;
  if (nextAction !== undefined) opportunity.nextAction = nextAction;
  if (nextActionDueAt !== undefined) opportunity.nextActionDueAt = nextActionDueAt;
  // Motivos só mudam junto com o desfecho validado (gravados normalizados, como o painel M3-17 agrega). CRMX-005: reabrir a
  // oportunidade NÃO apaga o motivo do desfecho anterior; ele continua no registro e na linha do tempo (DI-M3CA-7).
  if (outcome) {
    if (outcome.wonReason !== undefined) opportunity.wonReason = outcome.wonReason;
    if (outcome.lostReason !== undefined) {
      opportunity.lostReason = outcome.lostReason;
      opportunity.withdrawnReason = outcome.withdrawnReason;
    }
  }
  if (stage !== undefined) {
    opportunity.stage = nextStage;
    if (CLOSED_STAGES.includes(nextStage) && !opportunity.closedAt) {
      opportunity.closedAt = new Date();
    }
    if (!CLOSED_STAGES.includes(nextStage)) opportunity.closedAt = null;
  }

  opportunity.updatedBy = actorUserId || null;
  await opportunity.save({ transaction });

  if (stage !== undefined && nextStage !== previousStage) {
    await publishOpportunityStageChanged(opportunity, previousStage, transaction);
    if (nextStage === 'WON') await publishOpportunityWon(opportunity, transaction);
    if (nextStage === 'LOST') {
      await publishOpportunityLost(opportunity, transaction);
      // Guia §8: markLost cancela as tarefas futuras na mesma transação (vale para toda via que marca LOST).
      await cancelPendingTasks(opportunity, actorUserId, transaction, opportunity.lostReason);
    }
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
