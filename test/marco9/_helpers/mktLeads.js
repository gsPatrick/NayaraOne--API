'use strict';

// Apoio dos testes das automações de entrada do funil (M9-D420) e do Radar (M9-D421): lead com oportunidade e origem, mensagens do funil, automação instalada e
// o corretor responsável. Tudo roda na transação do teste (RLS real). Não é teste.
const env = require('./mktCadencia');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { withRollbackTenantTransaction } = require('../../testHelpers');

const { q, uid, readyPerson, addMessage, makeOpportunity, DAY, HOUR, NOON_SP } = env;

const { allowTestUrls } = require('./mktUrlPolicy');

/** Outro usuário real da empresa (o corretor dono da carteira, diferente de quem instala). */
async function broker(t, tenant) {
  const [row] = await q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId });
  if (!row) throw new Error('o seed precisa ter um segundo usuário');
  return row.id;
}

/** Lead com e-mail (e, se pedido, WhatsApp), oportunidade com origem e dono, nome no cadastro. `optIn`: finalidades com OPT_IN nos canais que ele tem. */
async function lead(t, tenant, { name = 'Ana Souza', source = 'FORM', owner, phone = false, email = true, optIn = [], stage = 'NEW' } = {}) {
  await allowTestUrls(t, tenant); // M9-D433: o link de descadastro passa pela regra de URL externa
  await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', tenant, tenant.userId, t);
  const personId = await readyPerson(t, tenant, { phone: phone ? undefined : null, email: email ? undefined : null, optIn });
  await q(t, 'UPDATE people.persons SET legal_name = :n WHERE id = :p RETURNING id', { n: name, p: personId });
  const opportunityId = await makeOpportunity(t, tenant, personId, { stage });
  await q(t, 'UPDATE crm.opportunities SET lead_source = :s, owner_user_id = :o WHERE id = :id RETURNING id', { s: source, o: owner || null, id: opportunityId });
  return { personId, opportunityId };
}

/** Evento crm.opportunity.created como o CRM publica (id da oportunidade, pessoa, imóvel e etapa). */
const leadEvent = (tenant, { personId, opportunityId }, over = {}) => env.eventFor(tenant, personId, { eventType: 'crm.opportunity.created', payload: { id: opportunityId, personId, stage: 'NEW' }, ...over });

/** Contato de uma pessoa da equipe (OUTBOUND) ou resposta do cliente (INBOUND) em `at`: o que a cadência de sem retorno e o cliente frio contam como interação. */
async function contact(t, tenant, personId, at, direction = 'OUTBOUND') {
  const [row] = await q(t, `INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status, created_at)
    VALUES (gen_random_uuid(), :g, :c, :p, 'WHATSAPP', :d, :a, :s, :at) RETURNING id`,
  { g: tenant.groupId, c: tenant.companyId, p: personId, d: direction, a: direction === 'INBOUND' ? 'CLIENT' : 'EMPLOYEE', s: direction === 'INBOUND' ? 'RECEIVED' : 'SENT', at });
  return row.id;
}

/** O teste simula dias: as mensagens que a automação acabou de gravar (hora real) passam a valer na hora simulada. */
const retime = (t, personId, at) => q(t, "UPDATE crm.messages SET created_at = :at WHERE person_id = :p AND direction = 'OUTBOUND' AND action_key IS NOT NULL AND created_at BETWEEN now() - interval '1 hour' AND now() + interval '1 minute' RETURNING id", { p: personId, at });
const ageOpportunities = (t, personId, at) => q(t, 'UPDATE crm.opportunities SET created_at = :at WHERE person_id = :p RETURNING id', { p: personId, at });

/** Radar ativo da pessoa, criado pelo corretor `brokerId`; devolve o id. */
async function radarOf(t, tenant, personId, brokerId, status = 'ACTIVE') {
  const radarId = await env.makeRadar(t, tenant, personId, { propertyTypes: ['RESIDENTIAL'], bedroomsMin: 2 }, status);
  await q(t, 'UPDATE crm.property_radars SET created_by = :b WHERE id = :id RETURNING id', { b: brokerId, id: radarId });
  return radarId;
}

/** Evento radar.matched como o radarMatchingJob publica (radar, pessoa e imóvel). */
const radarEvent = (tenant, { radarId, personId, propertyId }, over = {}) => env.eventFor(tenant, personId, { eventType: 'radar.matched', payload: { radarId, personId, propertyId }, ...over });
const notificationsOf = (t, userId) => q(t, 'SELECT title, body FROM core.notifications WHERE user_id = :u ORDER BY created_at, id', { u: userId });

const tasksOf = (t, tenant, personId) => q(t, "SELECT * FROM core.tasks WHERE company_id = :c AND (related_entity_id = :p OR related_entity_id IN (SELECT id FROM crm.opportunities WHERE person_id = :p)) ORDER BY created_at", { c: tenant.companyId, p: personId });
const outbound = (t, personId) => q(t, "SELECT id, status, purpose, channel, body, action_key, created_at FROM crm.messages WHERE person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at, id", { p: personId });
const setParam = (t, tenant, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);

module.exports = { ...env, withRollbackTenantTransaction, radarOf, radarEvent, notificationsOf, broker, contact, retime, ageOpportunities, lead, leadEvent, tasksOf, outbound, setParam, addMessage, DAY, HOUR, NOON_SP, uid };
