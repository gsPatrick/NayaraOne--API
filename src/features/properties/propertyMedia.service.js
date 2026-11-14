'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { PropertyMedia, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPropertyPublicSourceChanged } = require('./propertyEvents.service');
const { resolveScannedPropertyFile } = require('./propertyFile.guard');
const { revalidatePublication } = require('./publicationGate.service');

/**
 * propertyMedia.service.js — fotos, vídeos, plantas e tour do imóvel ("real_estate"."property_media"; livro do Marco 3 §6
 * "Media: Arquivo, ordem, classificação, qualidade").
 *
 * Verificação independente de 11/11/2026 (M3-06, M3-09): a mídia aceitava qualquer `storageKey` digitado, sem arquivo, e o
 * `qualityStatus` vinha do corpo (foto nascia APPROVED sem revisão). Agora:
 *  - a mídia exige `fileId` de um arquivo real da empresa, do tipo certo, examinado de novo pelo antivírus (propertyFile.guard);
 *    storage_key, nome, tipo e tamanho vêm do arquivo, nunca do corpo;
 *  - a qualidade sempre nasce PENDING: `qualityStatus` no corpo é recusado; só PATCH .../media/:id/quality aprova ou recusa;
 *  - criar e apagar mídia é auditado; apagar a mídia de imóvel publicado reconfere o gate (sem o vídeo, o imóvel sai do ar).
 * `position` define a ordem da galeria; sem ela, a mídia entra no fim.
 */
const MEDIA_TYPES = ['IMAGE', 'VIDEO', 'FLOORPLAN', 'TOUR_360', 'DOCUMENT'];

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createMedia(propertyId, payload, actor, transaction) {
  const { auth, actorUserId } = actor;
  const property = await assertPropertyExists(propertyId, transaction);
  const { mediaType, fileId, originalName, position, classification } = payload || {};

  if (payload && payload.qualityStatus !== undefined) {
    throw AppError.badRequest('A qualidade da mídia não vem no envio: toda mídia nasce PENDENTE e só a revisão (PATCH .../quality) aprova ou recusa.', 'PROPERTY_MEDIA_QUALITY_STATUS_NOT_ALLOWED');
  }
  if (!mediaType) {
    throw AppError.badRequest('O campo "mediaType" é obrigatório.', 'PROPERTY_MEDIA_VALIDATION');
  }
  const normalizedType = String(mediaType).toUpperCase();
  if (!MEDIA_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "mediaType" deve ser um de: ${MEDIA_TYPES.join(', ')}.`, 'PROPERTY_MEDIA_VALIDATION');
  }
  const { file, antivirus } = await resolveScannedPropertyFile(fileId, {
    use: normalizedType, auth, tenant: { groupId: property.groupId, companyId: property.companyId }, actorUserId, transaction,
  });

  let resolvedPosition = position;
  if (resolvedPosition === undefined || resolvedPosition === null || resolvedPosition === '') {
    const last = await PropertyMedia.findOne({ where: { propertyId }, order: [['position', 'DESC']], transaction });
    resolvedPosition = last && last.position != null ? last.position + 1 : 0;
  }

  const created = await PropertyMedia.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      mediaType: normalizedType,
      fileId: file.id,
      storageKey: file.storageKey,
      originalName: originalName || file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      position: resolvedPosition,
      classification: classification || null,
      qualityStatus: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await registrarAuditoria({
    groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.media.create', entityType: 'PropertyMedia', entityId: created.id,
    afterJson: { ...created.toJSON(), antivirus }, reason: `Mídia ${normalizedType} "${created.originalName}" anexada ao imóvel "${property.title}" (arquivo examinado pelo antivírus).`,
  }, transaction);
  await publishPropertyPublicSourceChanged(property, transaction);
  return created;
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

async function deleteMedia(propertyId, mediaId, actor, transaction) {
  const { auth, actorUserId } = actor;
  await legalHold.assertNotOnHold('PROPERTY', propertyId, transaction); // M9-D912
  const media = await PropertyMedia.findOne({ where: { id: mediaId, propertyId }, transaction });
  if (!media) throw AppError.notFound('Mídia não encontrada.', 'PROPERTY_MEDIA_NOT_FOUND');
  const beforeJson = media.toJSON();
  await media.destroy({ transaction });
  const property = await assertPropertyExists(propertyId, transaction);
  await registrarAuditoria({
    groupId: property.groupId, companyId: property.companyId, actorUserId, action: 'property.media.delete', entityType: 'PropertyMedia', entityId: mediaId,
    beforeJson, reason: `Mídia ${beforeJson.mediaType} "${beforeJson.originalName || mediaId}" removida do imóvel "${property.title}".`,
  }, transaction);
  const unpublished = await revalidatePublication(propertyId, auth || property, actorUserId, transaction, `mídia ${beforeJson.mediaType} removida`);
  await publishPropertyPublicSourceChanged(property, transaction);
  return { id: mediaId, unpublished: Boolean(unpublished), gateCode: unpublished };
}

module.exports = { createMedia, listMedia, deleteMedia, MEDIA_TYPES };
