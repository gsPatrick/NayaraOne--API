'use strict';

const { Visit, Property, Person, Opportunity } = require('../../models');
const AppError = require('../../utils/AppError');

const VISIT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'DONE', 'CANCELED', 'NO_SHOW'];

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

  return Visit.create(
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
}

async function listVisits(transaction, filters = {}) {
  const where = {};
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.opportunityId) where.opportunityId = filters.opportunityId;
  if (filters.personId) where.personId = filters.personId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Visit.findAll({ where, order: [['scheduled_at', 'DESC']], transaction });
}

async function getVisit(id, transaction) {
  const visit = await Visit.findByPk(id, { transaction });
  if (!visit) throw AppError.notFound('Visita não encontrada.', 'VISIT_NOT_FOUND');
  return visit;
}

async function updateVisit(id, payload, actorUserId, transaction) {
  const visit = await getVisit(id, transaction);
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
  visit.updatedBy = actorUserId || null;
  await visit.save({ transaction });
  return visit;
}

async function deleteVisit(id, actorUserId, transaction) {
  const visit = await getVisit(id, transaction);
  visit.deletedBy = actorUserId || null;
  await visit.save({ transaction });
  await visit.destroy({ transaction });
  return { id };
}

module.exports = { createVisit, listVisits, getVisit, updateVisit, deleteVisit, VISIT_STATUSES };
