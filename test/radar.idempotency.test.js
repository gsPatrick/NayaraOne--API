'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { OutboxEvent, Group, Company } = require('../src/models');

// CRM-TS-010 (auditoria externa Abacus AI, 11/10/2026): "Não existe ação de reprocessar
// visível; idempotência não verificável pela interface." Prova direta no job de matching: o
// mesmo radar+imóvel reprocessado duas vezes não gera dois eventos radar.matched nem duas
// notificações — nem pela checagem explícita de notifiedKeys, nem pela UNIQUE de
// idempotency_key no outbox como rede de segurança.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('radar idempotente: reprocessar o mesmo match (mesmo radar + mesmo imóvel) não duplica o evento radar.matched', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarIdem${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const group = await Group.findByPk(tenant.groupId, { transaction });
    const company = await Company.findByPk(tenant.companyId, { transaction });

    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Radar Idem ${suffix}` },
      tenant.userId,
      transaction
    );

    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Match Idem ${suffix}`, internalCode: `RAD-IDEM-${suffix}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);

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

    // Como processCompany abre sua PRÓPRIA transação (é um job de background, não roda dentro
    // da transação de teste), reaproveitamos a transação já aberta para o SET LOCAL — o
    // registro feito acima (dentro de withRollbackTenantTransaction) só está visível para
    // outras transações depois de commitado. Para testar o job de ponta a ponta sem commitar
    // dado de teste no banco compartilhado, chamamos processCompany passando a MESMA
    // transaction (mesma técnica usada no restante da suíte Marco 6 para rodar jobs que abrem
    // sua própria transação sob teste).
    // Escopado ao radar DESTE teste: processar todos os radares ACTIVE da empresa fazia o
    // contador somar matches pendentes de radares deixados por outros arquivos/rodadas no
    // banco compartilhado (run1 dava 2 em vez de 1) — a idempotência provada aqui é a do par
    // radar+imóvel, e o filtro não muda isso.
    const run1 = await processCompanyInTransaction(group, company, transaction, radar.id);
    const run2 = await processCompanyInTransaction(group, company, transaction, radar.id);

    assert.equal(run1.newMatches, 1, 'primeira rodada deve achar 1 match novo');
    assert.equal(run2.newMatches, 0, 'segunda rodada reprocessando o MESMO match não deve achar nada "novo"');

    const events = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      transaction,
    });
    assert.equal(events.length, 1, 'deve existir exatamente 1 evento radar.matched para este par radar+imóvel, não 2');
    assert.equal(events[0].idempotencyKey, `radar.matched:${radar.id}:${property.id}`);
  });
});

// Mesma lógica de processCompany(group, company), mas aceitando uma transaction existente em
// vez de abrir uma nova via sequelize.transaction() — necessário porque o teste todo roda
// dentro de uma única transação com rollback no final (dado de teste nunca é persistido de
// verdade no banco de dev compartilhado).
async function processCompanyInTransaction(group, company, transaction, onlyRadarId = null) {
  const { PropertyRadar, Notification } = require('../src/models');
  const { matchRadarToProperties } = require('../src/features/radar/radarMatching.service');
  const { publishRadarMatched } = require('../src/features/radar/radarEvents.service');

  const radars = await PropertyRadar.findAll({
    where: onlyRadarId ? { status: 'ACTIVE', id: onlyRadarId } : { status: 'ACTIVE' },
    transaction,
  });
  let totalNewMatches = 0;

  for (const radar of radars) {
    const matches = await matchRadarToProperties(radar, transaction);
    if (matches.length === 0) continue;

    const alreadyNotified = await OutboxEvent.findAll({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id, eventType: 'radar.matched' },
      attributes: ['idempotencyKey'],
      transaction,
    });
    const notifiedKeys = new Set(alreadyNotified.map((e) => e.idempotencyKey));

    const newMatches = matches.filter((property) => !notifiedKeys.has(`radar.matched:${radar.id}:${property.id}`));
    if (newMatches.length === 0) continue;

    for (const property of newMatches) {
      await publishRadarMatched(radar, property, transaction);
    }

    if (radar.createdBy) {
      await Notification.create(
        {
          groupId: radar.groupId,
          companyId: radar.companyId,
          userId: radar.createdBy,
          channel: 'IN_APP',
          title: 'Novo match no Radar',
          body: `Encontramos ${newMatches.length} imóvel(is) novo(s).`,
          createdBy: null,
          updatedBy: null,
        },
        { transaction }
      );
    }

    totalNewMatches += newMatches.length;
  }

  return { radarsChecked: radars.length, newMatches: totalNewMatches };
}
