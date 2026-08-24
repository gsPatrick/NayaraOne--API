'use strict';

const { PropertyMedia, Property } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * propertyMedia.service.js — CRUD de "real_estate"."property_media" (tabela criada pela
 * migration ...080). Cobre as fotos/vídeos/plantas do anúncio: a ficha do imóvel exibe a
 * galeria e o formulário de cadastro envia os itens enviados pelo operador.
 *
 * `storageKey` é a chave do arquivo no armazenamento (não o binário) — este service não faz
 * upload, apenas registra/lista os metadados da mídia, no mesmo modelo já usado por
 * person_documents.file_id.
 *
 * `position` define a ordem de exibição da galeria; quando não informada, a mídia entra no
 * fim da lista (maior position atual + 1).
 */

const MEDIA_TYPES = ['IMAGE', 'VIDEO', 'FLOORPLAN', 'TOUR_360', 'DOCUMENT'];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createMedia(propertyId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { mediaType, storageKey, originalName, mimeType, sizeBytes, position, classification, qualityStatus } = payload;

  if (!mediaType) {
    throw AppError.badRequest('O campo "mediaType" é obrigatório.', 'PROPERTY_MEDIA_VALIDATION');
  }
  const normalizedType = String(mediaType).toUpperCase();
  if (!MEDIA_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "mediaType" deve ser um de: ${MEDIA_TYPES.join(', ')}.`, 'PROPERTY_MEDIA_VALIDATION');
  }
  if (!storageKey) {
    throw AppError.badRequest('O campo "storageKey" é obrigatório.', 'PROPERTY_MEDIA_VALIDATION');
  }

  let resolvedPosition = position;
  if (resolvedPosition === undefined || resolvedPosition === null || resolvedPosition === '') {
    const last = await PropertyMedia.findOne({
      where: { propertyId },
      order: [['position', 'DESC']],
      transaction,
    });
    resolvedPosition = last && last.position != null ? last.position + 1 : 0;
  }

  return PropertyMedia.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      mediaType: normalizedType,
      storageKey,
      originalName: originalName || null,
      mimeType: mimeType || null,
      sizeBytes: sizeBytes !== undefined && sizeBytes !== '' ? sizeBytes : null,
      position: resolvedPosition,
      classification: classification || null,
      // quality_status é NOT NULL com default 'PENDING' (moderação da mídia) — passar null
      // explicitamente violaria a constraint, então só enviamos quando o payload informa.
      qualityStatus: qualityStatus || 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

async function listMedia(propertyId, transaction) {
  await assertPropertyExists(propertyId, transaction);
  return PropertyMedia.findAll({
    where: { propertyId },
    order: [
      ['position', 'ASC'],
      ['created_at', 'ASC'],
    ],
    transaction,
  });
}

async function deleteMedia(propertyId, mediaId, transaction) {
  const media = await PropertyMedia.findOne({ where: { id: mediaId, propertyId }, transaction });
  if (!media) throw AppError.notFound('Mídia não encontrada.', 'PROPERTY_MEDIA_NOT_FOUND');
  await media.destroy({ transaction });
  return { id: mediaId };
}

module.exports = { createMedia, listMedia, deleteMedia, MEDIA_TYPES };
