'use strict';

const { PropertyInternalOccurrence, Property } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * propertyInternalOccurrences.service.js — service SEPARADO do de properties/offers, por
 * design: "Permissão de leitura/escrita deve ser específica; conteúdo nunca vai
 * automaticamente para site/portais/IA pública" (citação literal do Caderno Técnico).
 *
 * Nenhuma função deste arquivo deve ser chamada a partir de um controller/rota que não seja
 * explicitamente interna (ver properties.routes.js — os endpoints deste recurso exigem a
 * permissão dedicada 'properties:internal', distinta de 'properties:read'/'properties:update').
 * Nunca inclua PropertyInternalOccurrence em properties.service.js/propertyOffers.service.js
 * ou em qualquer serialização pública.
 */

const OCCURRENCE_TYPES = [
  'TRADE_ACCEPTED',
  'VEHICLE_TRADE',
  'DOCUMENT_ISSUE',
  'NO_FINANCING',
  'SPECIFIC_NEGOTIATION',
  'RISK',
  'OWNER_NOTE',
];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createOccurrence(propertyId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { occurrenceType, description } = payload;
  if (!occurrenceType) {
    throw AppError.badRequest('O campo "occurrenceType" é obrigatório.', 'PROPERTY_INTERNAL_OCCURRENCE_VALIDATION');
  }
  const normalizedType = String(occurrenceType).toUpperCase();
  if (!OCCURRENCE_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(
      `O campo "occurrenceType" deve ser um de: ${OCCURRENCE_TYPES.join(', ')}.`,
      'PROPERTY_INTERNAL_OCCURRENCE_VALIDATION'
    );
  }
  if (!actorUserId) {
    throw AppError.badRequest('Ocorrência interna requer um usuário autor (created_by).', 'PROPERTY_INTERNAL_OCCURRENCE_VALIDATION');
  }

  return PropertyInternalOccurrence.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      occurrenceType: normalizedType,
      description: description || null,
      visibility: 'INTERNAL',
      createdBy: actorUserId,
    },
    { transaction }
  );
}

async function listOccurrences(propertyId, transaction) {
  await assertPropertyExists(propertyId, transaction);
  return PropertyInternalOccurrence.findAll({ where: { propertyId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { createOccurrence, listOccurrences, OCCURRENCE_TYPES };
