'use strict';

const { Visit, Property, Person, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');
const { withScope } = require('./carteira/carteira.scope');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { publishVisitScheduled, publishVisitCancelled, visitPayload } = require('./crmCalendarEvents.service');

const CLOSED_WITHOUT_VISIT = ['CANCELED', 'NO_SHOW'];
const OPEN_STATUSES = ['SCHEDULED', 'CONFIRMED'];

const VISIT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'DONE', 'CANCELED', 'NO_SHOW'];

/**
 * M3-24 (correção): agendar uma visita para o PASSADO era aceito sem reclamar, o que
 * produzia compromissos que ninguém jamais cumpriria e sujava a agenda/indicadores. Só vale
 * para os status prospectivos (SCHEDULED/CONFIRMED) — registrar depois do fato uma visita
 * que JÁ aconteceu (DONE/NO_SHOW/CANCELED) continua legítimo e comum na operação.
 * Tolerância de 5 minutos para diferença de relógio entre cliente e servidor.
 */
const PROSPECTIVE_STATUSES = ['SCHEDULED', 'CONFIRMED'];
const PAST_TOLERANCE_MS = 5 * 60 * 1000;

function assertNotScheduledInThePast(scheduledAt, status) {
  if (!PROSPECTIVE_STATUSES.includes(status)) return;
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) {
    throw AppError.badRequest('O campo "scheduledAt" deve ser uma data válida.', 'VISIT_VALIDATION');
  }
  if (when.getTime() < Date.now() - PAST_TOLERANCE_MS) {
    throw AppError.unprocessable(
      'Não é possível agendar uma visita para uma data no passado. Para registrar uma visita que já ocorreu, use o status DONE, NO_SHOW ou CANCELED.',
      'VISIT_SCHEDULED_IN_THE_PAST',
      { scheduledAt: when.toISOString(), status }
    );
  }
}

async function createVisit(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, opportunityId, personId, agentUserId, scheduledAt, status, feedback } = payload;
  if (!groupId || !companyId || !propertyId || !personId || !scheduledAt) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId", "personId" e "scheduledAt" são obrigatórios.',
      'VISIT_VALIDATION'
    );
  }

  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');

  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');

  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  const normalizedStatus = status ? String(status).toUpperCase() : 'SCHEDULED';
  if (!VISIT_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${VISIT_STATUSES.join(', ')}.`, 'VISIT_VALIDATION');
  }

  assertNotScheduledInThePast(scheduledAt, normalizedStatus);

  const visit = await Visit.create(
    {
      groupId,
      companyId,
      propertyId,
      opportunityId: opportunityId || null,
      personId,
      agentUserId: agentUserId || null,
      scheduledAt,
      status: normalizedStatus,
      feedback: feedback || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // Registro retroativo de visita que já aconteceu (status DONE direto na criação) também
  // dispara crm.visit.completed — não só a transição via updateVisit.
  if (normalizedStatus === 'DONE') {
    await publishDomainEvent(
      {
        groupId,
        companyId,
        aggregateType: 'Visit',
        aggregateId: visit.id,
        eventType: 'crm.visit.completed',
        payload: { id: visit.id, propertyId: visit.propertyId, personId: visit.personId, opportunityId: visit.opportunityId, ...visitPayload(visit, property.title) },
        idempotencyKey: `crm.visit.completed:${visit.id}`,
      },
      transaction
    );
  } else if (OPEN_STATUSES.includes(normalizedStatus)) {
    await publishVisitScheduled(visit, property.title, false, transaction);
  } else if (CLOSED_WITHOUT_VISIT.includes(normalizedStatus)) {
    await publishVisitCancelled(visit, property.title, transaction);
  }

  return visit;
}

async function listVisits(transaction, filters = {}) {
  const where = {};
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.opportunityId) where.opportunityId = filters.opportunityId;
  if (filters.personId) where.personId = filters.personId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  // CRM-TS-012: o corretor de escopo próprio só lista visitas da carteira (filters.carteira vem da rota).
  return Visit.findAll({ where: withScope(where, 'visit', filters.carteira), order: [['scheduled_at', 'DESC']], transaction });
}

async function getVisit(id, transaction) {
  const visit = await Visit.findByPk(id, { transaction });
  if (!visit) throw AppError.notFound('Visita não encontrada.', 'VISIT_NOT_FOUND');
  return visit;
}

async function updateVisit(id, payload, actorUserId, transaction) {
  const visit = await getVisit(id, transaction);
  const previousStatus = visit.status;
  const previousScheduledAt = visit.scheduledAt ? new Date(visit.scheduledAt).getTime() : null;
  const previousAgent = visit.agentUserId || null;
  const { scheduledAt, status, feedback, agentUserId } = payload;
  if (scheduledAt !== undefined) visit.scheduledAt = scheduledAt;
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!VISIT_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`O campo "status" deve ser um de: ${VISIT_STATUSES.join(', ')}.`, 'VISIT_VALIDATION');
    }
    visit.status = normalizedStatus;
  }
  if (feedback !== undefined) visit.feedback = feedback;
  if (agentUserId !== undefined) visit.agentUserId = agentUserId;
  // Reagendar para o passado tem o mesmo problema de criar no passado — a checagem só roda
  // quando a data foi efetivamente mexida (uma visita antiga pode ter outros campos editados).
  if (scheduledAt !== undefined) assertNotScheduledInThePast(visit.scheduledAt, visit.status);
  visit.updatedBy = actorUserId || null;
  await visit.save({ transaction });

  // Caderno (seção 17, "Eventos mínimos"): crm.visit.completed — dispara só na TRANSIÇÃO para
  // DONE (não reemite se a visita já estava DONE e outro campo foi editado).
  if (status !== undefined && visit.status === 'DONE' && previousStatus !== 'DONE') {
    await publishDomainEvent(
      {
        groupId: visit.groupId,
        companyId: visit.companyId,
        aggregateType: 'Visit',
        aggregateId: visit.id,
        eventType: 'crm.visit.completed',
        payload: { id: visit.id, propertyId: visit.propertyId, personId: visit.personId, opportunityId: visit.opportunityId, ...visitPayload(visit, await propertyTitleOf(visit, transaction)) },
        idempotencyKey: `crm.visit.completed:${visit.id}`,
      },
      transaction
    );
  } else if (visit.status !== 'DONE') {
    await publishVisitCalendarChange(visit, { previousStatus, previousScheduledAt, previousAgent }, transaction);
  }

  return visit;
}

async function propertyTitleOf(visit, transaction) {
  const property = await Property.findByPk(visit.propertyId, { transaction });
  return property ? property.title : null;
}

/** M9-D802: o que mudou na visita vira o evento do Calendário (cancelada, reagendada, agendada de novo); sem mudança relevante não publica. */
async function publishVisitCalendarChange(visit, previous, transaction) {
  const rescheduled = (visit.scheduledAt ? new Date(visit.scheduledAt).getTime() : null) !== previous.previousScheduledAt || (visit.agentUserId || null) !== previous.previousAgent;
  if (CLOSED_WITHOUT_VISIT.includes(visit.status)) {
    if (!CLOSED_WITHOUT_VISIT.includes(previous.previousStatus)) await publishVisitCancelled(visit, await propertyTitleOf(visit, transaction), transaction);
  } else if (OPEN_STATUSES.includes(visit.status) && (!OPEN_STATUSES.includes(previous.previousStatus) || rescheduled)) {
    await publishVisitScheduled(visit, await propertyTitleOf(visit, transaction), OPEN_STATUSES.includes(previous.previousStatus), transaction);
  }
}

async function deleteVisit(id, actorUserId, transaction) {
  const visit = await getVisit(id, transaction);
  visit.deletedBy = actorUserId || null;
  await visit.save({ transaction });
  await visit.destroy({ transaction });
  await publishVisitCancelled(visit, await propertyTitleOf(visit, transaction), transaction);
  return { id };
}

module.exports = { createVisit, listVisits, getVisit, updateVisit, deleteVisit, VISIT_STATUSES };
