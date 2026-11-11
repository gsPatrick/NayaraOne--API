'use strict';

/**
 * CRMX-007 (livro Marco 3 §2 "Radar automático — Novo imóvel ou novo cliente pode disparar matching por eventos"; §13; §17
 * `crm.radar.match.created`; Guia §9 criteria_version/fingerprint; CRM-TS-010 "Mesmo match reprocessado — Não duplica").
 * O matching nasce no DESPACHO do outbox (consumidor do Radar), não na requisição: radar novo/alterado, cliente novo com radar e
 * oferta nova/alterada (preço e status) publicam evento; o despacho grava crm.radar_matches + crm.radar.match.created +
 * radar.matched; o mesmo evento despachado de novo não duplica nada.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const radarService = require('../src/features/radar/radar.service');
const { CONSUMER } = require('../src/features/radar/radarEventConsumers');
const { OutboxEvent, RadarMatch, IntegrationInbox, PropertyRadar, AuditLog } = require('../src/models');
const { despacharNaTransacao, reabrirEventos } = require('./helpers/outboxEmTransacao');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const ev = (t, where) => OutboxEvent.findAll({ where, order: [['occurred_at', 'ASC']], transaction: t });
const matchCreated = (t, radarId) => OutboxEvent.count({ where: { eventType: 'crm.radar.match.created', payloadJson: { radarId } }, transaction: t });
const radarMatched = (t, radarId) => OutboxEvent.count({ where: { eventType: 'radar.matched', aggregateType: 'PropertyRadar', aggregateId: radarId }, transaction: t });
const stored = (t, radarId) => RadarMatch.count({ where: { radarId }, transaction: t });

async function pessoa(t, sfx) {
  return peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Cliente Radar Evento ${sfx}`, allowDuplicate: true }, tenant.userId, t);
}
async function imovel(t, sfx, city, price = 400000) {
  const property = await propertiesService.createProperty(
    { groupId: tenant.groupId, companyId: tenant.companyId, title: `Radar Evento ${sfx}`, internalCode: `RADEV-${sfx}`, propertyType: 'RESIDENTIAL', city, areaTotalM2: 90 },
    tenant.userId, t
  );
  const offer = await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: price }, tenant.userId, t);
  return { property, offer };
}
const radarPayload = (personId, city, extra = {}) => ({ groupId: tenant.groupId, companyId: tenant.companyId, personId, criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, ...extra } });

test('CRMX-007 radar novo: evento crm.radar.created no outbox, nada gravado antes do despacho; o despacho grava o match e os eventos; o mesmo evento 2x não duplica', async () => {
  const sfx = uniqueSuffix();
  const city = `RadEvNovo${sfx}`;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property } = await imovel(t, sfx, city);
    // O que o imóvel/oferta publicou já foi despachado (ainda não havia radar): fica só o efeito do radar.
    await despacharNaTransacao(tenant, t, { companyId: tenant.companyId, payloadJson: { propertyId: property.id } });
    const p = await pessoa(t, sfx);
    const { radar, matches } = await radarService.createRadar(radarPayload(p.id, city), tenant.userId, t);
    assert.equal(matches.length, 1, 'a resposta continua mostrando o match do momento (leitura)');

    const [criado] = await ev(t, { eventType: 'crm.radar.created', aggregateId: radar.id });
    assert.ok(criado, 'criar o radar publica crm.radar.created');
    assert.equal(criado.status, 'PENDING');
    assert.match(criado.payloadJson.criteriaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(await stored(t, radar.id), 0, 'nada gravado em crm.radar_matches antes do despacho');
    assert.equal(await matchCreated(t, radar.id), 0);
    assert.equal(await radarMatched(t, radar.id), 0);

    const r1 = await despacharNaTransacao(tenant, t, { id: criado.id });
    assert.equal(r1.dispatched, 1);
    assert.equal(await stored(t, radar.id), 1, 'o despacho gravou o match');
    const [m] = await RadarMatch.findAll({ where: { radarId: radar.id }, transaction: t });
    assert.equal(m.propertyId, property.id);
    assert.equal(m.criteriaVersion, 'radar-scoring-v2');
    assert.equal(m.criteriaFingerprint, criado.payloadJson.criteriaFingerprint);
    assert.equal(await matchCreated(t, radar.id), 1, 'crm.radar.match.created publicado no despacho');
    assert.equal(await radarMatched(t, radar.id), 1, 'radar.matched publicado no despacho');
    const audit = await AuditLog.findOne({ where: { entityType: 'PropertyRadar', entityId: radar.id, action: 'radar.event_matched' }, transaction: t });
    assert.equal(audit.afterJson.sourceEventType, 'crm.radar.created');

    await reabrirEventos([criado.id], t);
    const r2 = await despacharNaTransacao(tenant, t, { id: criado.id });
    assert.equal(r2.dispatched, 1, 'o mesmo evento foi entregue de novo aos consumidores');
    assert.equal(await stored(t, radar.id), 1, 'reprocesso não duplica o match');
    assert.equal(await matchCreated(t, radar.id), 1, 'reprocesso não duplica crm.radar.match.created');
    assert.equal(await radarMatched(t, radar.id), 1, 'reprocesso não duplica radar.matched');
    assert.equal(await IntegrationInbox.count({ where: { consumerName: CONSUMER, eventId: criado.id }, transaction: t }), 1);
  });
});

test('CRMX-007 cliente novo com radar: person.created despachado roda o radar do cliente', async () => {
  const sfx = uniqueSuffix();
  const city = `RadEvPessoa${sfx}`;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property } = await imovel(t, sfx, city);
    await despacharNaTransacao(tenant, t, { companyId: tenant.companyId, payloadJson: { propertyId: property.id } });
    // Cadastro que cria o cliente e o radar juntos (mesma transação): só o evento do cliente é despachado aqui.
    const p = await pessoa(t, sfx);
    const { radar } = await radarService.createRadar(radarPayload(p.id, city), tenant.userId, t);
    const [pessoaCriada] = await ev(t, { eventType: 'person.created', aggregateId: p.id });
    assert.ok(pessoaCriada);
    assert.equal(await stored(t, radar.id), 0);
    await despacharNaTransacao(tenant, t, { id: pessoaCriada.id });
    assert.equal(await stored(t, radar.id), 1, 'person.created disparou o matching do radar do cliente novo');
    assert.equal(await matchCreated(t, radar.id), 1);
    const audit = await AuditLog.findOne({ where: { entityType: 'PropertyRadar', entityId: radar.id, action: 'radar.event_matched' }, transaction: t });
    assert.equal(audit.afterJson.sourceEventType, 'person.created');
    // O evento do radar, despachado depois, não duplica.
    await despacharNaTransacao(tenant, t, { eventType: 'crm.radar.created', aggregateId: radar.id });
    assert.equal(await stored(t, radar.id), 1);
    assert.equal(await radarMatched(t, radar.id), 1);
  });
});

test('CRMX-007 oferta alterada: preço que entra na faixa e status que volta a ACTIVE refazem o matching por evento', async () => {
  const sfx = uniqueSuffix();
  const city = `RadEvOferta${sfx}`;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const p = await pessoa(t, sfx);
    const { radar } = await radarService.createRadar(radarPayload(p.id, city, { maxPrice: 500000 }), tenant.userId, t);
    await despacharNaTransacao(tenant, t, { aggregateId: [radar.id, p.id] });
    const { property, offer } = await imovel(t, sfx, city, 900000); // acima do máximo do radar
    await despacharNaTransacao(tenant, t, { companyId: tenant.companyId, payloadJson: { propertyId: property.id } });
    assert.equal(await stored(t, radar.id), 0, 'oferta fora da faixa não bate');

    // Preço: entra na faixa -> property.price.changed -> despacho -> match.
    await offersService.updateOffer(property.id, offer.id, { askingPrice: 450000 }, tenant.userId, t);
    const [preco] = await ev(t, { eventType: 'property.price.changed', aggregateId: offer.id, status: 'PENDING' });
    assert.ok(preco, 'a alteração de preço publicou property.price.changed');
    assert.equal(await stored(t, radar.id), 0, 'nada gravado antes do despacho');
    await despacharNaTransacao(tenant, t, { id: preco.id });
    assert.equal(await stored(t, radar.id), 1, 'o despacho do preço gravou o match');
    assert.equal(await radarMatched(t, radar.id), 1);

    // Status: pausa e reativa -> property.offer.status.changed -> o matching roda de novo (sem duplicar o que já existe).
    await offersService.updateOffer(property.id, offer.id, { status: 'PAUSED' }, tenant.userId, t);
    await offersService.updateOffer(property.id, offer.id, { status: 'ACTIVE' }, tenant.userId, t);
    const status = await ev(t, { eventType: 'property.offer.status.changed', aggregateId: offer.id });
    assert.deepEqual(status.map((e) => `${e.payloadJson.previousStatus}->${e.payloadJson.status}`), ['ACTIVE->PAUSED', 'PAUSED->ACTIVE']);
    const run = await despacharNaTransacao(tenant, t, { id: status.map((e) => e.id) });
    assert.equal(run.dispatched, 2);
    const inbox = await IntegrationInbox.count({ where: { consumerName: CONSUMER, eventId: status.map((e) => e.id) }, transaction: t });
    assert.equal(inbox, 2, 'o consumidor do Radar processou os dois eventos de status');
    assert.equal(await stored(t, radar.id), 1, 'mesmo critério + mesmo imóvel: não duplica');

    // Critério do radar alterado -> crm.radar.updated -> nova impressão digital -> novo registro (o anterior fica no histórico).
    await radarService.updateRadar(radar.id, { criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, maxPrice: 600000 } }, tenant.userId, t);
    const [alterado] = await ev(t, { eventType: 'crm.radar.updated', aggregateId: radar.id });
    assert.ok(alterado);
    await despacharNaTransacao(tenant, t, { id: alterado.id });
    assert.equal(await stored(t, radar.id), 2, 'critério novo grava novo match com outro fingerprint');
    assert.equal(await matchCreated(t, radar.id), 2);
  });
});

test('CRMX-007 radar inativo ou excluído: o evento despachado não grava nada', async () => {
  const sfx = uniqueSuffix();
  const city = `RadEvInativo${sfx}`;
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { property } = await imovel(t, sfx, city);
    await despacharNaTransacao(tenant, t, { companyId: tenant.companyId, payloadJson: { propertyId: property.id } });
    const p = await pessoa(t, sfx);
    const { radar } = await radarService.createRadar(radarPayload(p.id, city), tenant.userId, t);
    await PropertyRadar.update({ status: 'PAUSED' }, { where: { id: radar.id }, transaction: t });
    await despacharNaTransacao(tenant, t, { eventType: 'crm.radar.created', aggregateId: radar.id });
    assert.equal(await stored(t, radar.id), 0);
    assert.equal(await radarMatched(t, radar.id), 0);
  });
});
