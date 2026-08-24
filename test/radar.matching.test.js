'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('matching determinístico: radar retorna apenas properties com offer ACTIVE que batem em TODOS os critérios', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarCity${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Radar ${suffix}` },
      tenant.userId,
      transaction
    );

    // Property A: bate em todos os critérios (tipo, cidade, faixa de preço, área).
    const propertyA = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Match A ${suffix}`, internalCode: `RAD-A-${suffix}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(propertyA.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);

    // Property B: mesma cidade/tipo, mas preço fora da faixa (não deve bater).
    const propertyB = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `No Match Preço ${suffix}`, internalCode: `RAD-B-${suffix}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(propertyB.id, { offerType: 'SALE', askingPrice: 900000 }, tenant.userId, transaction);

    // Property C: preço e tipo batem, mas cidade diferente (não deve bater).
    const propertyC = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `No Match Cidade ${suffix}`,
        internalCode: `RAD-C-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city: `OutraCidade${suffix}`,
        areaTotalM2: 90,
      },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(propertyC.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);

    // Property D: tudo bate, mas a offer está PAUSED (não ACTIVE) — não deve bater.
    const propertyD = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `No Match Offer Inativa ${suffix}`, internalCode: `RAD-D-${suffix}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(propertyD.id, { offerType: 'SALE', askingPrice: 400000, status: 'PAUSED' }, tenant.userId, transaction);

    const { radar, matches } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        criteriaJson: {
          propertyType: 'RESIDENTIAL',
          offerType: 'SALE',
          city,
          minPrice: 350000,
          maxPrice: 500000,
          minAreaM2: 60,
        },
      },
      tenant.userId,
      transaction
    );
    assert.ok(radar.id);

    const matchIds = matches.map((m) => m.id).sort();
    assert.deepEqual(matchIds, [propertyA.id].sort());

    // GET /radar/:id/matches deve retornar exatamente o mesmo resultado determinístico.
    const matchesAgain = await radarService.getRadarMatches(radar.id, transaction);
    assert.deepEqual(
      matchesAgain.map((m) => m.id).sort(),
      [propertyA.id].sort()
    );
  });
});
