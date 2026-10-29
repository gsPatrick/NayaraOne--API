'use strict';

const { createVisit, deleteVisit } = require('../../../../crm/visits.service');
const { deletePerson } = require('../../../../people/person.service');
const { Visit } = require('../../../../../models');
const { findOrCreatePerson } = require('../people');
const { resolveRef } = require('../refs');
const { parseOccurredAt } = require('../../bcp.time');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/** REGISTER_VISIT: a visita do papel vira visita do CRM (já realizada, ou agendada se a data é futura). Confere cliente, imóvel e data e hora. */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const property = await resolveRef('property', payload.imovel, tenant, transaction);
  const when = parseOccurredAt(payload.dataHoraVisita);
  if (!when) throw commandRejected('a data e hora da visita é inválida');
  const { person, created } = await findOrCreatePerson({ tenant, actorUserId, name: payload.nomeCliente, phone: payload.telefone }, transaction);
  const visit = await createVisit({
    groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, personId: person.id, scheduledAt: when, status: when.getTime() <= Date.now() ? 'DONE' : 'SCHEDULED',
    feedback: `Origem BCP ${operation.manualReference}. Corretor: ${payload.corretor}.${payload.observacao ? ` ${payload.observacao}` : ''}`.slice(0, 2000),
  }, actorUserId, transaction);
  const saved = await Visit.findByPk(visit.id, { transaction });
  return {
    commandRef: `Visit:${saved.id}`,
    undo: { visitId: saved.id, personId: created ? person.id : null },
    comparisons: [
      { field: 'nomeCliente', label: 'Cliente', paper: normalize.text(payload.nomeCliente), command: normalize.text(person.legalName), kind: 'text' },
      { field: 'imovel', label: 'Imóvel', paper: normalize.id(property.id), command: normalize.id(saved.propertyId), kind: 'ref' },
      { field: 'dataHoraVisita', label: 'Data e hora da visita', paper: normalize.minute(payload.dataHoraVisita), command: normalize.minute(saved.scheduledAt), kind: 'datetime' },
    ],
  };
}

/** Estorno: a visita é excluída pelo serviço normal (cancelamento publicado) e a pessoa criada só por esta importação também. */
async function reverse({ actorUserId, effect, transaction }) {
  await deleteVisit(effect.visitId, actorUserId, transaction);
  if (effect.personId) await deletePerson(effect.personId, actorUserId, transaction);
}

module.exports = { action: 'REGISTER_VISIT', execute, reverse };
