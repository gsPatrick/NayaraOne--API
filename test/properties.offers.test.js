'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const { PropertyPriceHistory } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('offers: 2ª offer ACTIVE do mesmo tipo faz a 1ª virar SUPERSEDED (nunca duas ACTIVE simultâneas)', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Offers ${suffix}`,
        internalCode: `OFF-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city: 'São Paulo',
        state: 'SP',
        areaTotalM2: 80,
      },
      tenant.userId,
      transaction
    );

    const offer1 = await offersService.createOffer(
      property.id,
      { offerType: 'SALE', askingPrice: 500000 },
      tenant.userId,
      transaction
    );
    assert.equal(offer1.status, 'ACTIVE');

    const offer2 = await offersService.createOffer(
      property.id,
      { offerType: 'SALE', askingPrice: 520000 },
      tenant.userId,
      transaction
    );
    assert.equal(offer2.status, 'ACTIVE');

    const offer1Reloaded = await offersService.getOffer(property.id, offer1.id, transaction);
    assert.equal(offer1Reloaded.status, 'SUPERSEDED');

    // Uma offer RENT concorrente não deve ser afetada por offers SALE (tipos distintos).
    const rentOffer = await offersService.createOffer(
      property.id,
      { offerType: 'RENT', askingPrice: 2500 },
      tenant.userId,
      transaction
    );
    assert.equal(rentOffer.status, 'ACTIVE');
    const offer2Reloaded = await offersService.getOffer(property.id, offer2.id, transaction);
    assert.equal(offer2Reloaded.status, 'ACTIVE');

    const activeOffers = await offersService.listOffers(property.id, transaction, { status: 'ACTIVE' });
    const activeSaleOffers = activeOffers.filter((o) => o.offerType === 'SALE');
    assert.equal(activeSaleOffers.length, 1);
    assert.equal(activeSaleOffers[0].id, offer2.id);
  });
});

test('offers: mudança de preço gera INSERT append-only em property_price_history (nunca UPDATE do anterior)', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Price History ${suffix}`,
        internalCode: `PH-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    const offer = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 300000 }, tenant.userId, transaction);

    let history = await PropertyPriceHistory.findAll({ where: { offerId: offer.id }, transaction });
    assert.equal(history.length, 1);
    assert.equal(Number(history[0].newPrice), 300000);
    assert.equal(history[0].oldPrice, null);

    await offersService.updateOffer(property.id, offer.id, { askingPrice: 310000 }, tenant.userId, transaction);

    history = await PropertyPriceHistory.findAll({
      where: { offerId: offer.id },
      order: [['created_at', 'ASC']],
      transaction,
    });
    assert.equal(history.length, 2);
    assert.equal(Number(history[1].oldPrice), 300000);
    assert.equal(Number(history[1].newPrice), 310000);
    // O primeiro registro nunca é sobrescrito (append-only).
    assert.equal(Number(history[0].newPrice), 300000);
  });
});
