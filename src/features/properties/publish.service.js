'use strict';

const { Property, PropertyOffer, PropertyMedia } = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { publishPropertyPublished } = require('./propertyEvents.service');

/**
 * publishOffer — POST /offers/:id/publish
 *
 * Ao publicar uma oferta, o imóvel associado só é movido para publication_status='PUBLISHED'
 * se REG-IMO-001 ("Vídeo obrigatório para publicação") permitir. A validação passa pelo Motor
 * de Regras (evaluateRule, fail-closed) — nunca é um `if` hardcoded aqui: computamos o fato
 * `hasVideo` a partir de "real_estate"."property_media" e delegamos a decisão à regra
 * publicada para o tenant (ver scripts/seedRealEstateRules.js). Se a regra não estiver
 * semeada, evaluateRule já retorna DENY por padrão — a publicação fica bloqueada, nunca
 * liberada por omissão.
 */
async function publishOffer(offerId, tenant, actorUserId, transaction) {
  const offer = await PropertyOffer.findByPk(offerId, { transaction });
  if (!offer) throw AppError.notFound('Oferta não encontrada.', 'PROPERTY_OFFER_NOT_FOUND');

  const property = await Property.findByPk(offer.propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');

  const videoCount = await PropertyMedia.count({
    where: { propertyId: property.id, mediaType: 'VIDEO' },
    transaction,
  });
  const hasVideo = videoCount > 0;

  const evaluation = await evaluateRule('REG-IMO-001', { hasVideo }, tenant, { transaction });

  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Publicação bloqueada: vídeo obrigatório ausente.',
      'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001',
      { ruleDecision: evaluation.decision, reason: evaluation.reason }
    );
  }

  property.publicationStatus = 'PUBLISHED';
  property.updatedBy = actorUserId || null;
  await property.save({ transaction });

  await publishPropertyPublished(property, transaction);

  return { property, offer };
}

module.exports = { publishOffer };
