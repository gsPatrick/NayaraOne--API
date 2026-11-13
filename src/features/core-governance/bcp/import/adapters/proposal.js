'use strict';

const { Op } = require('sequelize');
const { createProposal, updateProposalStatus } = require('../../../../crm/proposals.service');
const { createOpportunity, deleteOpportunity } = require('../../../../crm/opportunity.service');
const { deletePerson } = require('../../../../people/person.service');
const { Opportunity, Proposal, Person } = require('../../../../../models');
const { getSetting } = require('../../../../settings/settings.service');
const { IMPORT_LEAD_HOURS_KEY, BCP_SETTING_DEFAULTS } = require('../../bcp.settings');
const { findOrCreatePerson } = require('../people');
const { resolveRef } = require('../refs');
const normalize = require('../normalize');

const { CLOSED_STAGE_CODES: CLOSED } = require('../../../../crm/opportunityStages');

/** Oportunidade aberta do proponente no imóvel, ou uma nova (pelo serviço normal), onde a proposta se pendura. */
async function ensureOpportunity({ tenant, actorUserId, operation, person, property, nextAction }, transaction) {
  const open = await Opportunity.findOne({ where: { personId: person.id, propertyId: property.id, stage: { [Op.notIn]: CLOSED } }, order: [['created_at', 'DESC']], transaction });
  if (open) return { opportunity: open, created: false };
  const hours = Number(await getSetting(IMPORT_LEAD_HOURS_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[IMPORT_LEAD_HOURS_KEY]));
  const opportunity = await createOpportunity({
    groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, propertyId: property.id, ownerUserId: actorUserId, stage: 'NEW',
    nextAction: nextAction || `Acompanhar a proposta de locação do formulário ${operation.manualReference}`, nextActionDueAt: new Date(Date.now() + hours * 3600 * 1000),
  }, actorUserId, transaction);
  return { opportunity, created: true };
}

/** REGISTER_PROPOSAL: a proposta de locação do papel vira proposta (rascunho) do CRM, na oportunidade do proponente. Confere documento, imóvel e valor. */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const property = await resolveRef('property', payload.imovel, tenant, transaction);
  const { person, created: personCreated } = await findOrCreatePerson({ tenant, actorUserId, name: payload.proponente, document: payload.documento }, transaction);
  const { opportunity, created: opportunityCreated } = await ensureOpportunity({ tenant, actorUserId, operation, person, property }, transaction);
  const proposal = await createProposal({
    groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, propertyId: property.id, proposedByPersonId: person.id, value: payload.valorAluguelCentavos / 100,
    status: 'DRAFT', notes: `Origem BCP ${operation.manualReference}. Prazo: ${payload.prazoMeses} meses. Garantia oferecida: ${payload.garantia}.${payload.observacao ? ` ${payload.observacao}` : ''}`.slice(0, 2000),
  }, actorUserId, transaction);
  const saved = await Proposal.findByPk(proposal.id, { transaction });
  const proponent = await Person.findByPk(saved.proposedByPersonId, { transaction });
  return {
    commandRef: `Proposal:${saved.id}`,
    undo: { proposalId: saved.id, opportunityId: opportunityCreated ? opportunity.id : null, personId: personCreated ? person.id : null },
    comparisons: [
      { field: 'documento', label: 'Documento do proponente', paper: normalize.digits(payload.documento), command: normalize.digits(proponent && proponent.taxIdNormalized), kind: 'digits' },
      { field: 'imovel', label: 'Imóvel', paper: normalize.id(property.id), command: normalize.id(saved.propertyId), kind: 'ref' },
      { field: 'valorAluguelCentavos', label: 'Valor do aluguel (centavos)', paper: normalize.cents(payload.valorAluguelCentavos), command: normalize.cents(saved.value, { fromDecimal: true }), kind: 'cents' },
    ],
  };
}

/** Estorno: a proposta é recusada (REJECTED, o histórico fica) e a oportunidade e a pessoa criadas só por esta importação saem. */
async function reverse({ actorUserId, effect, transaction }) {
  await updateProposalStatus(effect.proposalId, { status: 'REJECTED', notes: 'Estornada por decisão da divergência (BCP).' }, actorUserId, transaction);
  if (effect.opportunityId) await deleteOpportunity(effect.opportunityId, actorUserId, transaction);
  if (effect.personId) await deletePerson(effect.personId, actorUserId, transaction);
}

module.exports = { action: 'REGISTER_PROPOSAL', execute, reverse, ensureOpportunity };
