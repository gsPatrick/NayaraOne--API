'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events de mudança de estágio de Opportunity (Transactional Outbox).

async function publishOpportunityCreated(opportunity, transaction) {
  return publishDomainEvent(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      aggregateType: 'Opportunity',
      aggregateId: opportunity.id,
      eventType: 'crm.opportunity.stage_changed',
      payload: { id: opportunity.id, fromStage: null, toStage: opportunity.stage },
      idempotencyKey: `crm.opportunity.stage_changed:${opportunity.id}:${opportunity.stage}:created`,
    },
    transaction
  );
}

async function publishOpportunityStageChanged(opportunity, previousStage, transaction) {
  return publishDomainEvent(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      aggregateType: 'Opportunity',
      aggregateId: opportunity.id,
      eventType: 'crm.opportunity.stage_changed',
      payload: { id: opportunity.id, fromStage: previousStage, toStage: opportunity.stage },
      idempotencyKey: `crm.opportunity.stage_changed:${opportunity.id}:${opportunity.stage}:${Date.now()}`,
    },
    transaction
  );
}

// Caderno (seção 17, "Eventos mínimos"): crm.opportunity.created é um evento PRÓPRIO, distinto
// de crm.opportunity.stage_changed (que publishOpportunityCreated acima também emite com
// fromStage=null por motivo histórico — mantido para não quebrar nenhum consumidor existente
// desse evento). Quem for ouvir só a criação da oportunidade deve ouvir este, não inferir pelo
// stage_changed com fromStage nulo.
async function publishOpportunityCreatedEvent(opportunity, transaction) {
  return publishDomainEvent(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      aggregateType: 'Opportunity',
      aggregateId: opportunity.id,
      eventType: 'crm.opportunity.created',
      payload: { id: opportunity.id, personId: opportunity.personId, propertyId: opportunity.propertyId, stage: opportunity.stage },
      idempotencyKey: `crm.opportunity.created:${opportunity.id}`,
    },
    transaction
  );
}

// Caderno (seção 17): crm.opportunity.won e crm.opportunity.lost são eventos distintos do
// genérico stage_changed — publicados além dele (não em vez dele) quando a oportunidade entra
// no estágio terminal correspondente.
async function publishOpportunityWon(opportunity, transaction) {
  return publishDomainEvent(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      aggregateType: 'Opportunity',
      aggregateId: opportunity.id,
      eventType: 'crm.opportunity.won',
      payload: { id: opportunity.id, wonReason: opportunity.wonReason, closedAt: opportunity.closedAt },
      idempotencyKey: `crm.opportunity.won:${opportunity.id}:${opportunity.closedAt instanceof Date ? opportunity.closedAt.toISOString() : opportunity.closedAt}`,
    },
    transaction
  );
}

async function publishOpportunityLost(opportunity, transaction) {
  return publishDomainEvent(
    {
      groupId: opportunity.groupId,
      companyId: opportunity.companyId,
      aggregateType: 'Opportunity',
      aggregateId: opportunity.id,
      eventType: 'crm.opportunity.lost',
      payload: { id: opportunity.id, lostReason: opportunity.lostReason, closedAt: opportunity.closedAt },
      idempotencyKey: `crm.opportunity.lost:${opportunity.id}:${opportunity.closedAt instanceof Date ? opportunity.closedAt.toISOString() : opportunity.closedAt}`,
    },
    transaction
  );
}

module.exports = {
  publishOpportunityCreated,
  publishOpportunityStageChanged,
  publishOpportunityCreatedEvent,
  publishOpportunityWon,
  publishOpportunityLost,
};
