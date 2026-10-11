'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { OutboxEvent } = require('../src/models');

// CRMX-007 (Caderno Técnico, Marco 3, seção 2): "Novo imóvel ou novo cliente pode disparar
// matching por eventos." Até esta correção, um imóvel novo só era descoberto pelos radares
// ativos na PRÓXIMA rodada do job periódico (radarMatchingJob.js) — nunca no instante em que
// a oferta é publicada. Este teste prova que criar uma offer ACTIVE para um imóvel que já bate
// com um radar existente gera o evento radar.matched IMEDIATAMENTE, dentro da própria
// transação de createOffer, sem rodar o job.
let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('CRMX-007: criar uma offer ACTIVE dispara o matching do Radar na hora (evento), não só no próximo job periódico', async () => {
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

    // Este createOffer é o evento real — SEM rodar radarMatchingJob.js nem GET /radar/:id/matches.
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 420000 }, tenant.userId, transaction);

    const afterOfferEvents = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(afterOfferEvents.length, 1, 'criar a offer ACTIVE deve disparar o evento radar.matched imediatamente');
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

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(events.length, 0, 'cidade diferente não deve bater com o critério do radar');
  });
});
