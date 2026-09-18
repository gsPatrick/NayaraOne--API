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

// FIX AUD-2026-09-14 (reportado pela cliente: imóvel aparece simultaneamente como "Publicado" e
// "Sem oferta") — reproduz o caso real: imóvel PUBLISHED com uma offer ACTIVE; ao pausar/encerrar
// essa offer (a última ACTIVE), o imóvel precisa voltar pra INACTIVE automaticamente, nunca ficar
// PUBLISHED sem nenhuma offer ACTIVE por trás.
test('offers: encerrar a última offer ACTIVE de um imóvel PUBLISHED despublica ele automaticamente', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Unpublish ${suffix}`,
        internalCode: `UNP-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    const offer = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);
    assert.equal(offer.status, 'ACTIVE');

    // Simula o imóvel já publicado (sem depender da regra de vídeo obrigatório do publish.service).
    await propertiesService.updateProperty(property.id, { publicationStatus: 'PUBLISHED' }, tenant.userId, transaction);

    await offersService.updateOffer(property.id, offer.id, { status: 'CLOSED' }, tenant.userId, transaction);

    const propertyAfter = await propertiesService.getProperty(property.id, transaction);
    assert.equal(
      propertyAfter.publicationStatus,
      'INACTIVE',
      'imóvel não pode continuar PUBLISHED depois que a última offer ACTIVE foi encerrada — era exatamente o defeito reportado'
    );

    const remainingActive = await offersService.listOffers(property.id, transaction, { status: 'ACTIVE' });
    assert.equal(remainingActive.length, 0);
  });
});

test('offers: publicar um imóvel que ainda tem outra offer ACTIVE do mesmo tipo NÃO despublica ao encerrar a supersedida', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Unpublish Mantém ${suffix}`,
        internalCode: `UNPM-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    const offer1 = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);
    const offer2 = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 420000 }, tenant.userId, transaction);
    // offer1 já virou SUPERSEDED automaticamente aqui (offer2 é a ACTIVE atual).

    await propertiesService.updateProperty(property.id, { publicationStatus: 'PUBLISHED' }, tenant.userId, transaction);

    // Tentar "reencerrar" a offer1 (já SUPERSEDED, nunca foi a ACTIVE vigente nesta chamada)
    // não pode mexer na publicação, porque offer2 continua ACTIVE sustentando ela.
    await offersService.updateOffer(property.id, offer1.id, { status: 'CLOSED' }, tenant.userId, transaction);

    const propertyAfter = await propertiesService.getProperty(property.id, transaction);
    assert.equal(propertyAfter.publicationStatus, 'PUBLISHED', 'não pode despublicar enquanto ainda existe outra offer ACTIVE (offer2)');
  });
});

// FIX (reportado pela cliente 18/09/2026 — "Edifício Aurora — Apto 302" encontrado PUBLISHED
// sem NENHUMA offer, nem sequer inativa): o gate de "última offer ACTIVE encerrada" acima não
// cobre o caso de um imóvel publicado que NUNCA teve nenhuma offer — o endpoint genérico
// updateProperty(publicationStatus) não checava isso.
test('offers: NÃO é possível publicar um imóvel que nunca teve nenhuma offer', async () => {
  const suffix = uniqueSuffix();

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Sem Offer ${suffix}`,
        internalCode: `SEMOFFER-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => propertiesService.updateProperty(property.id, { publicationStatus: 'PUBLISHED' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER');
        return true;
      },
      'imóvel sem NENHUMA offer não pode ser publicado — era exatamente o defeito reportado no imóvel real'
    );

    const propertyAfter = await propertiesService.getProperty(property.id, transaction);
    assert.notEqual(propertyAfter.publicationStatus, 'PUBLISHED');
  });
});
