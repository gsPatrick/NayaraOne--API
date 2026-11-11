'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { OutboxEvent } = require('../src/models');
require('../src/features/radar/radarEventConsumers'); // consumidor do Radar registrado para o despacho
const { despacharNaTransacao } = require('./helpers/outboxEmTransacao');

// CRMX-007 (Caderno Técnico, Marco 3, seção 2): "Novo imóvel ou novo cliente pode disparar
// matching por eventos." Um imóvel novo não espera a PRÓXIMA rodada do job periódico
// (radarMatchingJob.js): criar a offer publica property.offer.created no outbox, na transação
// de createOffer, e o consumidor do Radar faz o matching no despacho do outbox (sem o job).
let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('CRMX-007: criar uma offer ACTIVE dispara o matching do Radar por evento (despacho do outbox), não só no próximo job periódico', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarEvt${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Radar Evento ${suffix}` },
      tenant.userId,
      transaction
    );

    const { radar } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city },
      },
      tenant.userId,
      transaction
    );

    // Nenhum match deve existir ainda — nenhum imóvel compatível foi criado.
    const beforeEvents = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(beforeEvents.length, 0, 'não deve haver match antes do imóvel existir');

    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Match Evento ${suffix}`, internalCode: `RAD-EVT-${suffix}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );

    // O imóvel sozinho (sem offer ACTIVE) não compõe um match válido para o critério offerType.
    const afterPropertyOnly = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(afterPropertyOnly.length, 0, 'property sem offer ACTIVE ainda não deve gerar match');

    // Este createOffer publica o evento real — SEM rodar radarMatchingJob.js nem GET /radar/:id/matches.
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 420000 }, tenant.userId, transaction);
    const antesDoDespacho = await OutboxEvent.count({ where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' }, transaction });
    assert.equal(antesDoDespacho, 0, 'o matching não roda na requisição: espera o despacho do evento');
    await despacharNaTransacao(tenant, transaction, { eventType: 'property.offer.created', payloadJson: { propertyId: property.id } });

    const afterOfferEvents = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(afterOfferEvents.length, 1, 'o despacho do evento da offer ACTIVE deve publicar radar.matched');
    assert.equal(afterOfferEvents[0].idempotencyKey, `radar.matched:${radar.id}:${property.id}`);
    assert.equal(afterOfferEvents[0].payloadJson.personId, person.id);
  });
});

test('CRMX-007: criar offer que NÃO bate com nenhum radar ativo não gera evento nenhum', async () => {
  const suffix = uniqueSuffix();
  const cityRadar = `RadarNoMatchA${suffix}`;
  const cityProperty = `RadarNoMatchB${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Radar Sem Match ${suffix}` },
      tenant.userId,
      transaction
    );
    const { radar } = await radarService.createRadar(
      { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city: cityRadar } },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Sem Match ${suffix}`, internalCode: `RAD-NOMATCH-${suffix}`, propertyType: 'RESIDENTIAL', city: cityProperty, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 420000 }, tenant.userId, transaction);
    await despacharNaTransacao(tenant, transaction, { eventType: 'property.offer.created', payloadJson: { propertyId: property.id } });

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(events.length, 0, 'cidade diferente não deve bater com o critério do radar');
  });
});
