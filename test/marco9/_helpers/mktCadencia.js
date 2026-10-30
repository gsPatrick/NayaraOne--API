'use strict';

// Apoio dos testes das automações prontas do Marketing (M9-D422): contrato com contraparte, entrega de chaves, automação instalada, evento de entrada e datas da agenda. Não é teste.
const env = require('./mktRunner');
const { installSeed } = require('../../../src/features/marketing/automations/seeds');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { useTempSecretStore } = require('./mktSecretStore');

const { q, uid } = env;
const base = (tenant) => ({ g: tenant.groupId, c: tenant.companyId });
const survey = 'https://pesquisa.exemplo.com.br/satisfacao';
const ISO = (date) => new Date(date).toISOString();

/** Pessoa só com e-mail (o canal automático cai nele) e OPT_IN em POS_VENDA, ou sem consentimento nenhum. */
async function person(t, tenant, { optIn = true, link = true } = {}) {
  if (link) await upsertSetting('marketing.pos_chaves.link_pesquisa', survey, tenant, tenant.userId, t);
  await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', tenant, tenant.userId, t); // e-mail de marketing exige o descadastro
  return env.readyPerson(t, tenant, { phone: null, optIn: optIn ? ['POS_VENDA'] : [] });
}

async function contract(t, tenant, { type = 'SALE', status = 'ACTIVE', startsAt = null, personId, role = 'BUYER' } = {}) {
  const [row] = await q(t, `INSERT INTO legal.contracts (id, group_id, company_id, contract_type, status, total_value, starts_at, lock_version)
    VALUES (gen_random_uuid(), :g, :c, :ty, :st, 1000, :sa, 0) RETURNING id`, { ...base(tenant), ty: type, st: status, sa: startsAt });
  await q(t, `INSERT INTO legal.contract_parties (id, group_id, company_id, contract_id, person_id, party_role) VALUES (gen_random_uuid(), :g, :c, :k, :p, :r) RETURNING id`,
    { ...base(tenant), k: row.id, p: personId, r: role });
  return row.id;
}

async function keyDelivery(t, tenant, { contractId, personId, deliveredAt = '2026-11-10T15:00:00Z' }) {
  const [row] = await q(t, `INSERT INTO legal.key_deliveries (id, group_id, company_id, contract_id, delivered_to_person_id, status, delivered_at)
    VALUES (gen_random_uuid(), :g, :c, :k, :p, 'RELEASED', :at) RETURNING id`, { ...base(tenant), k: contractId, p: personId, at: deliveredAt });
  return row.id;
}

/** Entrega de chaves completa: contrato de venda ativo, contraparte e a entrega. */
async function delivered(t, tenant, personId, over = {}) {
  const contractId = await contract(t, tenant, { personId, ...over.contract });
  const deliveryId = await keyDelivery(t, tenant, { contractId, personId, deliveredAt: over.deliveredAt });
  return { contractId, deliveryId };
}

const install = (t, tenant, code, extra = {}) => installSeed({ code, tenant, actor: tenant.userId, ...extra }, t);

/** Evento keys.delivered como o Jurídico publica (id da entrega, contrato e pessoa). */
const keysEvent = (tenant, personId, { contractId, deliveryId }, over = {}) => env.eventFor(tenant, personId, { eventType: 'keys.delivered', payload: { id: deliveryId, contractId, deliveredToPersonId: personId }, ...over });

/** Evento contract.activated como o Jurídico publica (id e tipo do contrato; sem pessoa: o runner acha a contraparte). */
const activatedEvent = (tenant, contractId, contractType, over = {}) => ({
  ...env.eventFor(tenant, null, { eventType: 'contract.activated', payload: { id: contractId, contractType }, ...over }), aggregateType: 'Contract', aggregateId: contractId,
});

const dueDates = (row) => row.actions_result.map((a) => (a.due_at ? ISO(a.due_at) : null));
const at10 = (day) => `${day}T13:00:00.000Z`; // 10:00 em São Paulo (UTC-3)
const dueAt = (t, tenant, now) => env.runner.runDueActions(tenant, t, { now: new Date(now), mode: 'SANDBOX' });

module.exports = { ...env, useTempSecretStore, person, contract, keyDelivery, delivered, install, keysEvent, activatedEvent, dueDates, at10, dueAt, survey, ISO, base, uid };
