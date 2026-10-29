'use strict';

// Massa de dados de Locação da M9-D617 para os testes de worker e de rebuild: cria a fonte numa empresa e devolve um evento por entidade.
const bi = require('./biEnv');

const { src, makeEvent } = bi;
const iso = (date, time = '15:00:00') => `${date}T${time}Z`;

async function seed(env, tenant) {
  const property = await src.property(env, tenant, { status: 'RENTED', created: iso('2026-09-01') });
  const vacant = await src.property(env, tenant, { status: 'AVAILABLE', created: iso('2026-09-20') });
  await src.offer(env, tenant, { property: vacant, type: 'RENT' });
  const contract = await src.contract(env, tenant, { status: 'ACTIVE', property, value: '3200.00', startsAt: iso('2026-09-01') });
  const entry = await src.entry(env, tenant, { contract, amount: '3200.00', due: iso('2026-10-10') });
  const guarantee = await src.guarantee(env, tenant, { contract, type: 'GUARANTOR', endsAt: '2026-11-05' });
  await src.requirement(env, tenant, { contract });
  await src.utility(env, tenant, { contract });
  const inspection = await src.inspection(env, tenant, { contract, status: 'COMPLETED' });
  const keys = await src.keyDelivery(env, tenant, { contract, status: 'RELEASED' });
  const ticket = await src.maintenance(env, tenant, { property, status: 'OPEN', created: iso('2026-10-28', '13:00:00') });
  const person = src.uuid();
  await src.party(env, tenant, { contract, person });
  const feedback = await src.feedback(env, tenant, { person, type: 'COMPLIMENT', created: iso('2026-10-05') });
  const repass = await src.repass(env, tenant, { amount: '2900.00', month: '2026-09' });
  return [
    makeEvent(tenant, 'legal.contract.status_changed', { id: contract }), makeEvent(tenant, 'property.created', { id: vacant }),
    makeEvent(tenant, 'finance.entry.created', { id: entry }), makeEvent(tenant, 'legal.guarantee.created', { id: guarantee }),
    makeEvent(tenant, 'legal.inspection.completed', { id: inspection }), makeEvent(tenant, 'legal.key_delivery.released', { id: keys }),
    makeEvent(tenant, 'warranty.case.opened', { id: ticket }), makeEvent(tenant, 'crm.feedback_case.created', { id: feedback }),
    makeEvent(tenant, 'finance.owner_repasse.created', { id: repass }),
  ];
}

module.exports = { seed, iso };
