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

/**
 * publishPersonMerged — payload inclui `remappedReferences` (mapa tabela -> quantidade de
 * linhas remapeadas do absorvido para o canônico) desde o reforço do item 1 do ciclo de
 * auditoria externa Marco 3: "Gerar evento person.merged e audit log com mapa de
 * referências." (Caderno §29, passo 8) — antes o payload só tinha os dois ids, sem dizer o
 * que de fato foi remapeado.
 */
async function publishPersonMerged(canonicalPerson, absorbedPerson, remappedReferences, transaction) {
  return publishDomainEvent(
    {
      groupId: canonicalPerson.groupId,
      companyId: canonicalPerson.companyId,
      aggregateType: 'Person',
      aggregateId: canonicalPerson.id,
      eventType: 'person.merged',
      payload: { canonicalId: canonicalPerson.id, absorbedId: absorbedPerson.id, remappedReferences: remappedReferences || {} },
      idempotencyKey: `person.merged:${canonicalPerson.id}:${absorbedPerson.id}`,
    },
    transaction
  );
}

module.exports = { publishPersonCreated, publishPersonMerged };
