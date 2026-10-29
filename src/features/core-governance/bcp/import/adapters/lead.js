'use strict';

const { createOpportunity, deleteOpportunity } = require('../../../../crm/opportunity.service');
const { deletePerson } = require('../../../../people/person.service');
const { getSetting } = require('../../../../settings/settings.service');
const { Opportunity } = require('../../../../../models');
const { IMPORT_LEAD_HOURS_KEY, BCP_SETTING_DEFAULTS } = require('../../bcp.settings');
const { findOrCreatePerson, primaryPhoneOf } = require('../people');
const { resolveRef } = require('../refs');
const normalize = require('../normalize');

/** "Origem" escrita no papel -> uma das origens do rastreio de leads (DI-D832-2); o que não reconhece vira OTHER. */
const SOURCE_HINTS = [['WHATSAPP', /whats|zap/], ['PHONE', /telefon|ligac|fone/], ['EMAIL', /e-?mail/], ['PORTAL', /portal|zap imoveis|olx|vivareal/], ['SITE', /site|pagina/], ['SOCIAL', /insta|face|social|rede|tiktok/],
  ['REFERRAL', /indica|amig|conhecid/], ['FORM', /formulario|form\b|balcao|presencial/]];
const leadSourceOf = (origin) => (SOURCE_HINTS.find(([, rx]) => rx.test(normalize.text(origin))) || ['OTHER'])[0];

/** REGISTER_LEAD: o lead do papel vira pessoa (se nova) e oportunidade do CRM, pelos serviços normais. Confere nome e telefone. */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const { person, created } = await findOrCreatePerson({ tenant, actorUserId, name: payload.nome, phone: payload.telefone, email: payload.email }, transaction);
  const property = payload.imovelInteresse ? await resolveRef('property', payload.imovelInteresse, tenant, transaction).catch(() => null) : null;
  const hours = Number(await getSetting(IMPORT_LEAD_HOURS_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[IMPORT_LEAD_HOURS_KEY]));
  const opportunity = await createOpportunity({
    groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, propertyId: property ? property.id : null, ownerUserId: actorUserId, stage: 'NEW',
    nextAction: `Primeiro contato com o lead registrado no formulário ${operation.manualReference} (interesse: ${payload.interesse}${payload.imovelInteresse && !property ? `; imóvel citado: ${payload.imovelInteresse}` : ''}${payload.observacao ? `; ${payload.observacao}` : ''})`.slice(0, 500),
    nextActionDueAt: new Date(Date.now() + hours * 3600 * 1000), leadSource: leadSourceOf(payload.origem),
  }, actorUserId, transaction);
  const saved = await Opportunity.findByPk(opportunity.id, { transaction });
  return {
    commandRef: `Opportunity:${saved.id}`,
    undo: { opportunityId: saved.id, personId: created ? person.id : null },
    comparisons: [
      { field: 'nome', label: 'Nome', paper: normalize.text(payload.nome), command: normalize.text(person.legalName), kind: 'text' },
      { field: 'telefone', label: 'Telefone', paper: normalize.digits(payload.telefone), command: await primaryPhoneOf(person.id, transaction), kind: 'digits' },
    ],
  };
}

/** Estorno do lead: a oportunidade sai do funil (exclusão lógica do serviço normal) e a pessoa criada só por esta importação também. */
async function reverse({ actorUserId, effect, transaction }) {
  await deleteOpportunity(effect.opportunityId, actorUserId, transaction);
  if (effect.personId) await deletePerson(effect.personId, actorUserId, transaction);
}

module.exports = { action: 'REGISTER_LEAD', execute, reverse, leadSourceOf };
