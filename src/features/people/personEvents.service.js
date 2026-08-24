'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo people (Transactional Outbox), seguindo exatamente o
// mesmo padrão de src/features/properties/propertyEvents.service.js. Eventos confirmados pelo
// Caderno: person.created, person.merged.

async function publishPersonCreated(person, transaction) {
  return publishDomainEvent(
    {
      groupId: person.groupId,
      companyId: person.companyId,
      aggregateType: 'Person',
      aggregateId: person.id,
      eventType: 'person.created',
      payload: { id: person.id, personType: person.personType, legalName: person.legalName },
      idempotencyKey: `person.created:${person.id}`,
    },
    transaction
  );
}

async function publishPersonMerged(canonicalPerson, absorbedPerson, transaction) {
  return publishDomainEvent(
    {
      groupId: canonicalPerson.groupId,
      companyId: canonicalPerson.companyId,
      aggregateType: 'Person',
      aggregateId: canonicalPerson.id,
      eventType: 'person.merged',
      payload: { canonicalId: canonicalPerson.id, absorbedId: absorbedPerson.id },
      idempotencyKey: `person.merged:${canonicalPerson.id}:${absorbedPerson.id}`,
    },
    transaction
  );
}

module.exports = { publishPersonCreated, publishPersonMerged };
