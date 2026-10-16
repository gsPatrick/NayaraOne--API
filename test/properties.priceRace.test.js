'use strict';

/**
 * CRM-TS-014 (Caderno Técnico, Marco 3, seção 19 — testes adversariais): "Price race — 2
 * alterações simultâneas — Lock/version history correto." Prova de corrida REAL: duas
 * transações commitadas em paralelo, cada uma tentando mudar o preço da MESMA offer.
 *
 * Sem o FOR UPDATE adicionado em updateOffer (ver propertyOffers.service.js), as duas
 * transações liam o mesmo `askingPrice` em memória ANTES de qualquer commit, então os dois
 * PropertyPriceHistory gravados citavam o mesmo `oldPrice` — ambos "a partir do preço
 * original" — mesmo a segunda mudança tendo na verdade acontecido sobre o preço que a
 * primeira já tinha deixado. Com o lock, a segunda transação só lê a offer depois da primeira
 * commitar, então grava a cadeia real (oldPrice da segunda == newPrice da primeira).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const { PropertyPriceHistory, Property } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function withCommittedTenantTransaction(tenantCtx, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantCtx.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantCtx.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantCtx.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

test('CRM-TS-014: duas alterações de preço CONCORRENTES na mesma offer serializam corretamente (sem lost update, histórico com oldPrice real)', async () => {
  const suffix = uniqueSuffix();
  const created = {};

  try {
    Object.assign(
      created,
      await withCommittedTenantTransaction(tenant, async (transaction) => {
        const property = await propertiesService.createProperty(
          { groupId: tenant.groupId, companyId: tenant.companyId, title: `Price Race ${suffix}`, internalCode: `PRICE-RACE-${suffix}`, propertyType: 'RESIDENTIAL', city: `RaceCity${suffix}`, areaTotalM2: 80 },
          tenant.userId,
          transaction
        );
        const offer = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 300000 }, tenant.userId, transaction);
        return { propertyId: property.id, offerId: offer.id };
      })
    );

    // Corrida REAL: duas transações commitadas em paralelo mudando o preço da MESMA offer.
    const results = await Promise.allSettled([
      withCommittedTenantTransaction(tenant, (t) =>
        offersService.updateOffer(created.propertyId, created.offerId, { askingPrice: 310000 }, tenant.userId, t)
      ),
      withCommittedTenantTransaction(tenant, (t) =>
        offersService.updateOffer(created.propertyId, created.offerId, { askingPrice: 320000 }, tenant.userId, t)
      ),
    ]);

    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(okCount, 2, 'as duas alterações devem ter sucesso — o lock serializa, não rejeita');

    const finalOffer = await withCommittedTenantTransaction(tenant, (t) =>
      offersService.getOffer(created.propertyId, created.offerId, t)
    );
    // O preço final é o da transação que commitou por último (lock serializa a ORDEM real de
    // execução; não sabemos de antemão qual delas "ganhou", só que o resultado é consistente).
    assert.ok([310000, 320000].includes(Number(finalOffer.askingPrice)));

    const history = await withCommittedTenantTransaction(tenant, (t) =>
      PropertyPriceHistory.findAll({ where: { offerId: created.offerId }, order: [['created_at', 'ASC']], transaction: t })
    );
    // 1 registro da criação (OFFER_CREATED, oldPrice null) + 2 da corrida = 3.
    assert.equal(history.length, 3, 'deve existir 1 histórico de criação + 2 da corrida, nenhum perdido');

    const raceEntries = history.filter((h) => h.reasonCode === 'PRICE_UPDATE');
    assert.equal(raceEntries.length, 2);

    // O INVARIANTE que prova que o lock funcionou: a cadeia de oldPrice/newPrice é CONTÍNUA —
    // o oldPrice do segundo registro da corrida é exatamente o newPrice do primeiro. Sem o
    // FOR UPDATE, os dois registros teriam oldPrice=300000 (o valor lido antes de qualquer
    // commit), quebrando essa continuidade.
    const sorted = raceEntries.sort((a, b) => a.createdAt - b.createdAt);
    assert.equal(Number(sorted[0].oldPrice), 300000, 'primeira mudança da corrida parte do preço original');
    assert.equal(
      Number(sorted[1].oldPrice),
      Number(sorted[0].newPrice),
      'segunda mudança da corrida deve partir do preço que a primeira deixou (cadeia contínua, sem lost update)'
    );
  } finally {
    if (created.propertyId) {
      await withCommittedTenantTransaction(tenant, async (t) => {
        await sequelize.query('DELETE FROM "real_estate"."property_price_history" WHERE offer_id = :id', {
          replacements: { id: created.offerId },
          transaction: t,
        });
        await sequelize.query('DELETE FROM "real_estate"."property_offers" WHERE id = :id', {
          replacements: { id: created.offerId },
          transaction: t,
        });
        await sequelize.query('DELETE FROM "real_estate"."properties" WHERE id = :id', {
          replacements: { id: created.propertyId },
          transaction: t,
        });
      });
    }
  }
});
