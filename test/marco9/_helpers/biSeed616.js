'use strict';

// Massa de dados de Comercial/CRM e Imóveis da M9-D616 para os testes de worker e de rebuild: cria a fonte numa empresa e devolve os eventos que
// o Financeiro/CRM publicariam para cada entidade (um por entidade, para o incremental cobrir todos os agregados).
const bi = require('./biEnv');

const { src, makeEvent } = bi;
const iso = (date, time = '15:00:00') => `${date}T${time}Z`;

async function seed(env, tenant) {
  const broker = src.uuid();
  const o1 = await src.opportunity(env, tenant, { owner: broker, source: 'SITE', stage: 'NEW', created: iso('2026-10-20'), nextAction: 'Ligar' });
  const o2 = await src.opportunity(env, tenant, { owner: broker, source: 'SITE', stage: 'QUALIFIED', created: iso('2026-10-21'), updated: iso('2026-10-22') });
  const won = await src.opportunity(env, tenant, { owner: broker, source: 'INDICACAO', stage: 'WON', created: iso('2026-10-10'), closedAt: iso('2026-10-18') });
  const lost = await src.opportunity(env, tenant, { owner: broker, stage: 'LOST', created: iso('2026-10-11'), closedAt: iso('2026-10-19'), lostReason: 'PRICE' });
  await src.message(env, tenant, { opportunity: o1, created: iso('2026-10-20', '15:10:00') });
  const prop = await src.property(env, tenant, { createdBy: broker, publishedAt: iso('2026-10-15'), created: iso('2026-10-14') });
  const visit = await src.visit(env, tenant, { at: iso('2026-10-26'), status: 'DONE', property: prop });
  const proposal = await src.proposal(env, tenant, { opportunity: o2, status: 'ACCEPTED', sentAt: iso('2026-10-26'), decidedAt: iso('2026-10-27') });
  await src.priceHistory(env, tenant, { oldPrice: '100.00', newPrice: '120.00', at: iso('2026-10-25') });
  const person = src.uuid();
  await src.radarEvent(env, tenant, { person, property: prop, at: iso('2026-10-24') });
  return [
    makeEvent(tenant, 'crm.opportunity.created', { id: o1 }), makeEvent(tenant, 'crm.opportunity.created', { id: o2 }),
    makeEvent(tenant, 'crm.opportunity.created', { id: won }), makeEvent(tenant, 'crm.opportunity.created', { id: lost }),
    makeEvent(tenant, 'crm.opportunity.won', { id: won }), makeEvent(tenant, 'crm.opportunity.lost', { id: lost }),
    makeEvent(tenant, 'property.created', { id: prop }), makeEvent(tenant, 'crm.visit.completed', { id: visit }),
    makeEvent(tenant, 'crm.proposal.status_changed', { id: proposal, fromStatus: 'SENT', toStatus: 'ACCEPTED' }),
    makeEvent(tenant, 'property.price.changed', { offerId: src.uuid() }, { occurredAt: new Date(iso('2026-10-25')) }),
    makeEvent(tenant, 'radar.matched', { radarId: src.uuid(), personId: person, propertyId: prop }, { occurredAt: new Date(iso('2026-10-24')) }),
  ];
}

module.exports = { seed, iso };
