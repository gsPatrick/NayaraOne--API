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

module.exports = { publishOpportunityCreated, publishOpportunityStageChanged };
