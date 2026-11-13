'use strict';

const { PropertyMedia, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPropertyPublicSourceChanged } = require('./propertyEvents.service');
const { revalidatePublication } = require('./publicationGate.service');

/**
 * Qualidade da mídia do imóvel (livro do Marco 3 §6 "Media: arquivo, ordem, classificação, qualidade" e §7 "Publicação usa
 * Motor de Regras para checar ... quantidade/qualidade de fotos"; Guia §6 `approvedPhotoCount`).
 *
 * PHOTO_MEDIA_TYPES: a API grava foto como IMAGE (propertyMedia.service MEDIA_TYPES); PHOTO é o nome antigo, ainda presente
 * em registros anteriores. Antes, o gate de publicação, o PATCH de publicação e o carrinho contavam só PHOTO: foto enviada
 * pela tela nunca contava e o imóvel não publicava.
 *
 * reviewMediaQuality: aprovação/recusa da foto pela pessoa que revisa (a recusa exige motivo), auditada com antes/depois.
 * A foto original nunca é alterada aqui (só o status de qualidade): storage_key e original_name ficam como foram enviados.
 */
const PHOTO_MEDIA_TYPES = ['IMAGE', 'PHOTO'];
const REVIEW_STATUSES = ['APPROVED', 'REJECTED', 'PENDING'];

async function reviewMediaQuality(propertyId, mediaId, payload, actorUserId, transaction, tenant) {
  const status = String((payload && payload.qualityStatus) || '').toUpperCase();
  if (!REVIEW_STATUSES.includes(status)) {
    throw AppError.badRequest(`O campo "qualityStatus" deve ser um de: ${REVIEW_STATUSES.join(', ')}.`, 'PROPERTY_MEDIA_VALIDATION');
  }
  const reason = payload && typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (status === 'REJECTED' && reason.length < 3) {
    throw AppError.badRequest('Informe o motivo da recusa da mídia (ex.: pessoa na foto, placa, documento exposto, baixa qualidade).', 'PROPERTY_MEDIA_REJECTION_REASON_REQUIRED');
  }
  const media = await PropertyMedia.findOne({ where: { id: mediaId, propertyId }, lock: transaction.LOCK.UPDATE, transaction });
  if (!media) throw AppError.notFound('Mídia não encontrada.', 'PROPERTY_MEDIA_NOT_FOUND');
  const beforeJson = media.toJSON();
  media.qualityStatus = status;
  media.updatedBy = actorUserId || null;
  await media.save({ transaction });
  await registrarAuditoria(
    {
      groupId: media.groupId,
      companyId: media.companyId,
      actorUserId,
      action: 'property.media.quality_review',
      entityType: 'PropertyMedia',
      entityId: media.id,
      beforeJson,
      afterJson: media.toJSON(),
      reason: reason || `Qualidade da mídia revisada: ${status}.`,
    },
    transaction
  );
  // Vídeo ou foto aprovada que passa a recusada (ou volta a pendente) pode tirar o imóvel publicado do gate: reconfere.
  if (beforeJson.qualityStatus === 'APPROVED' && status !== 'APPROVED') {
    await revalidatePublication(propertyId, tenant || media, actorUserId, transaction, `mídia ${media.mediaType} saiu de APROVADA para ${status}`);
  }
  await publishPropertyPublicSourceChanged(await Property.findByPk(propertyId, { transaction }), transaction);
  return media;
}

module.exports = { PHOTO_MEDIA_TYPES, REVIEW_STATUSES, reviewMediaQuality };
