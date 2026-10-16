'use strict';

/**
 * Caderno Técnico, Marco 3, seção 17 ("Eventos mínimos"): prova de que os 6 eventos que
 * faltavam agora são publicados no outbox transacional. Achado numa verificação cética
 * (11/10/2026) que releu a seção 17 linha a linha e confirmou, via grep de todo `eventType:`
 * no código, que person.updated/property.updated/crm.opportunity.created/won/lost/
 * crm.interaction.recorded/crm.visit.completed nunca eram emitidos — só os outros 7 eventos
 * da lista existiam.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const messagesService = require('../src/features/crm/messages.service');
const visitsService = require('../src/features/crm/visits.service');
const { OutboxEvent } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function findEvent(eventType, aggregateId, transaction) {
  return OutboxEvent.findOne({ where: { eventType, aggregateId }, transaction, order: [['created_at', 'DESC']] });
}

test('Eventos mínimos: person.updated é publicado ao atualizar uma pessoa', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Evt ${suffix}` },
      tenant.userId,
      transaction
    );
    await peopleService.updatePerson(person.id, { preferredName: 'Apelido Novo' }, tenant.userId, transaction);

    const event = await findEvent('person.updated', person.id, transaction);
    assert.ok(event, 'esperava um evento person.updated no outbox');
  });
});

test('Eventos mínimos: property.updated é publicado ao atualizar um imóvel', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Evt ${suffix}`,
        internalCode: `EVT-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    await propertiesService.updateProperty(property.id, { description: 'Descrição atualizada' }, tenant.userId, transaction, tenant);

    const event = await findEvent('property.updated', property.id, transaction);
    assert.ok(event, 'esperava um evento property.updated no outbox');
  });
});

test('Eventos mínimos: crm.opportunity.created é publicado (distinto do stage_changed genérico)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Evt ${suffix}` },
      tenant.userId,
      transaction
    );
    const opportunity = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        stage: 'QUALIFYING',
        nextAction: 'Ligar',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );

    const event = await findEvent('crm.opportunity.created', opportunity.id, transaction);
    assert.ok(event, 'esperava um evento crm.opportunity.created no outbox');
  });
});

test('Eventos mínimos: crm.opportunity.won e crm.opportunity.lost são publicados nas transições terminais', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const personWon = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Won ${suffix}` },
      tenant.userId,
      transaction
    );
    const oppWon = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: personWon.id,
        stage: 'QUALIFYING',
        nextAction: 'Ligar',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );
    await opportunitiesService.updateOpportunity(oppWon.id, { stage: 'CLOSED_WON', wonReason: 'PRICE_ACCEPTED' }, tenant.userId, transaction);
    const wonEvent = await findEvent('crm.opportunity.won', oppWon.id, transaction);
    assert.ok(wonEvent, 'esperava um evento crm.opportunity.won no outbox');

    const personLost = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead Lost ${suffix}` },
      tenant.userId,
      transaction
    );
    const oppLost = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: personLost.id,
        stage: 'QUALIFYING',
        nextAction: 'Ligar',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );
    await opportunitiesService.updateOpportunity(oppLost.id, { stage: 'CLOSED_LOST', lostReason: 'PRICE_TOO_HIGH' }, tenant.userId, transaction);
    const lostEvent = await findEvent('crm.opportunity.lost', oppLost.id, transaction);
    assert.ok(lostEvent, 'esperava um evento crm.opportunity.lost no outbox');
  });
});

test('Eventos mínimos: crm.interaction.recorded é publicado ao criar uma mensagem/interação', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Contato Evt ${suffix}` },
      tenant.userId,
      transaction
    );
    const message = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        channel: 'WHATSAPP',
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: 'Olá, tenho interesse no imóvel.',
      },
      tenant.userId,
      transaction
    );

    const event = await findEvent('crm.interaction.recorded', message.id, transaction);
    assert.ok(event, 'esperava um evento crm.interaction.recorded no outbox');
  });
});

test('Eventos mínimos: crm.visit.completed é publicado ao concluir (DONE) uma visita', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Visitante ${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Visita ${suffix}`,
        internalCode: `VIS-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    const visit = await visitsService.createVisit(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        personId: person.id,
        scheduledAt: new Date(Date.now() + 3600000),
        status: 'SCHEDULED',
      },
      tenant.userId,
      transaction
    );

    await visitsService.updateVisit(visit.id, { status: 'DONE' }, tenant.userId, transaction);
    const event = await findEvent('crm.visit.completed', visit.id, transaction);
    assert.ok(event, 'esperava um evento crm.visit.completed no outbox (transição p/ DONE)');

    // Reconfirma que atualizar OUTRO campo de uma visita já DONE não duplica o evento.
    const countBefore = await OutboxEvent.count({ where: { eventType: 'crm.visit.completed', aggregateId: visit.id }, transaction });
    await visitsService.updateVisit(visit.id, { feedback: 'Cliente gostou muito.' }, tenant.userId, transaction);
    const countAfter = await OutboxEvent.count({ where: { eventType: 'crm.visit.completed', aggregateId: visit.id }, transaction });
    assert.equal(countAfter, countBefore, 'editar outro campo de visita já DONE não deve reemitir crm.visit.completed');
  });
});

test('Eventos mínimos: registrar visita já concluída (status DONE na criação) também dispara crm.visit.completed', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Visitante Retro ${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Visita Retro ${suffix}`,
        internalCode: `VISR-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    const visit = await visitsService.createVisit(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        personId: person.id,
        scheduledAt: new Date(Date.now() - 3600000),
        status: 'DONE',
      },
      tenant.userId,
      transaction
    );

    const event = await findEvent('crm.visit.completed', visit.id, transaction);
    assert.ok(event, 'esperava um evento crm.visit.completed no outbox (criação direta com status DONE)');
  });
});
