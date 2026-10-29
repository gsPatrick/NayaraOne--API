'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { createPerson } = require('../../../people/person.service');
const { createOpportunity } = require('../../../crm/opportunity.service');
const { Property } = require('../../../../models');
const { inTenantTx } = require('../consumers/tenantTx');
const E = require('./clients.errors');
const S = require('./clients.settings');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Confere o corpo do lead; devolve { name, email, phone, message, propertyId } limpos ou lança 422 com os problemas por campo. */
function checkLead(body) {
  const problems = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 160) problems.push({ field: 'name', reason: 'informe o nome (2 a 160 caracteres)' });
  const email = body.email === undefined || body.email === null ? null : String(body.email).trim().toLowerCase();
  if (email !== null && (!EMAIL.test(email) || email.length > 254)) problems.push({ field: 'email', reason: 'informe um e-mail válido' });
  const phone = body.phone === undefined || body.phone === null ? null : String(body.phone).replace(/\D/g, '');
  if (phone !== null && (phone.length < 10 || phone.length > 13)) problems.push({ field: 'phone', reason: 'informe o telefone com DDD (10 a 13 dígitos)' });
  if (email === null && phone === null) problems.push({ field: 'contact', reason: 'informe e-mail ou telefone' });
  if (body.propertyId !== undefined && body.propertyId !== null && !UUID.test(String(body.propertyId))) problems.push({ field: 'propertyId', reason: 'identificador de imóvel inválido' });
  if (body.message !== undefined && body.message !== null && (typeof body.message !== 'string' || body.message.length > 1000)) problems.push({ field: 'message', reason: 'a mensagem tem até 1000 caracteres' });
  if (problems.length) throw E.leadInvalid({ problems });
  return { name, email, phone, message: body.message || null, propertyId: body.propertyId || null };
}

/**
 * POST /api-external/leads (scope leads:write): cria a pessoa e a oportunidade NOVA (funil comercial) da empresa da credencial, pelos mesmos serviços da tela. A primeira ação (`nextAction`)
 * vence em `governanca.api.externo.lead_prazo_horas`. Duplicidade de documento ou contato é 409 (nada é sobrescrito).
 */
async function createLead(client, body = {}) {
  const lead = checkLead(body);
  return inTenantTx(client, async (transaction) => {
    if (lead.propertyId && !(await Property.findByPk(lead.propertyId, { transaction }))) throw E.leadInvalid({ problems: [{ field: 'propertyId', reason: 'imóvel não encontrado' }] });
    const hours = Number(await getSetting(S.LEAD_DEADLINE_KEY, client, transaction, S.CLIENTS_SETTING_DEFAULTS[S.LEAD_DEADLINE_KEY]));
    const contacts = [];
    if (lead.email) contacts.push({ contactType: 'EMAIL', value: lead.email, isPrimary: true });
    if (lead.phone) contacts.push({ contactType: 'PHONE', value: lead.phone, isPrimary: !lead.email });
    let person;
    try {
      person = await createPerson({ groupId: client.groupId, companyId: client.companyId, personType: 'PF', legalName: lead.name, contacts }, null, transaction);
    } catch (err) {
      if (err && /^PERSON_DUPLICATE/.test(err.code || '')) throw E.leadDuplicate();
      throw err;
    }
    const opportunity = await createOpportunity({
      groupId: client.groupId, companyId: client.companyId, personId: person.id, propertyId: lead.propertyId, stage: 'NEW',
      nextAction: lead.message ? `Contatar lead de parceiro: ${lead.message.slice(0, 200)}` : 'Contatar lead recebido por parceiro',
      nextActionDueAt: new Date(Date.now() + hours * 3600000),
    }, null, transaction);
    return { opportunityId: opportunity.id, stage: opportunity.stage, nextActionDueAt: opportunity.nextActionDueAt };
  });
}

module.exports = { createLead, checkLead };
