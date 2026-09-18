'use strict';

const { PropertyRadar, Person, Opportunity, Property, PropertyOffer } = require('../../models');
const AppError = require('../../utils/AppError');
const { matchRadarToProperties, explainMatch } = require('./radarMatching.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// CRUD de PropertyRadar — o matching determinístico contra properties/offers vive em
// radarMatching.service.js; este service apenas orquestra o CRUD e aciona o matching quando
// o radar é criado/atualizado ou consultado explicitamente.

async function createRadar(payload, actorUserId, transaction) {
  const { groupId, companyId, personId, opportunityId, criteriaJson, status } = payload;
  if (!groupId || !companyId || !personId || !criteriaJson) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "personId" e "criteriaJson" são obrigatórios.',
      'RADAR_VALIDATION'
    );
  }

  const person = await Person.findByPk(personId, { transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'PERSON_NOT_FOUND');

  if (opportunityId) {
    const opportunity = await Opportunity.findByPk(opportunityId, { transaction });
    if (!opportunity) throw AppError.notFound('Oportunidade não encontrada.', 'OPPORTUNITY_NOT_FOUND');
  }

  const radar = await PropertyRadar.create(
    {
      groupId,
      companyId,
      personId,
      opportunityId: opportunityId || null,
      criteriaJson,
      status: status || 'ACTIVE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const matches = await matchRadarToProperties(radar, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'radar.create',
      entityType: 'PropertyRadar',
      entityId: radar.id,
      afterJson: radar.toJSON(),
      reason: `Radar de busca criado para "${person.legalName || personId}" (${matches.length} match${matches.length === 1 ? '' : 'es'} no momento).`,
    },
    transaction
  );

  return { radar, matches };
}

async function listRadars(transaction, filters = {}) {
  const where = {};
  if (filters.personId) where.personId = filters.personId;
  if (filters.status) where.status = filters.status;
  return PropertyRadar.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getRadar(id, transaction) {
  const radar = await PropertyRadar.findByPk(id, { transaction });
  if (!radar) throw AppError.notFound('Radar não encontrado.', 'RADAR_NOT_FOUND');
  return radar;
}

async function updateRadar(id, payload, actorUserId, transaction) {
  const radar = await getRadar(id, transaction);
  const beforeJson = radar.toJSON();
  const { criteriaJson, status } = payload;
  if (criteriaJson !== undefined) radar.criteriaJson = criteriaJson;
  if (status !== undefined) radar.status = status;
  radar.updatedBy = actorUserId || null;
  await radar.save({ transaction });

  const matches = await matchRadarToProperties(radar, transaction);

  await registrarAuditoria(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      actorUserId,
      action: 'radar.update',
      entityType: 'PropertyRadar',
      entityId: radar.id,
      beforeJson,
      afterJson: radar.toJSON(),
      reason: `Radar de busca atualizado (${matches.length} match${matches.length === 1 ? '' : 'es'} no momento).`,
    },
    transaction
  );

  return { radar, matches };
}

async function deleteRadar(id, actorUserId, transaction) {
  const radar = await getRadar(id, transaction);
  const beforeJson = radar.toJSON();
  radar.deletedBy = actorUserId || null;
  await radar.save({ transaction });
  await radar.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      actorUserId,
      action: 'radar.delete',
      entityType: 'PropertyRadar',
      entityId: radar.id,
      beforeJson,
      reason: 'Radar de busca excluído.',
    },
    transaction
  );

  return { id };
}

async function getRadarMatches(id, transaction) {
  const radar = await getRadar(id, transaction);
  return matchRadarToProperties(radar, transaction);
}

/**
 * M3-15 — explicação do match de UM imóvel específico contra UM radar. Não mexe no matching
 * determinístico (matchRadarToProperties continua sendo a fonte de verdade de "quem aparece
 * na lista"); serve pra responder "por que este imóvel bate / não bate".
 */
async function explainRadarMatch(radarId, propertyId, transaction) {
  const radar = await getRadar(radarId, transaction);
  const property = await Property.findByPk(propertyId, {
    include: [{ model: PropertyOffer, as: 'offers', required: false }],
    transaction,
  });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return explainMatch(radar, property);
}

module.exports = {
  createRadar,
  explainRadarMatch,
  listRadars,
  getRadar,
  updateRadar,
  deleteRadar,
  getRadarMatches,
  matchRadarToProperties,
};
