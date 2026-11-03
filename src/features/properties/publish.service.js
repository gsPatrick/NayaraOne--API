'use strict';

const { Property, PropertyOffer, PropertyMedia, PropertyDocument } = require('../../models');
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

  // FIX (homologação 22/09/2026 — auditoria proativa): publishOffer nunca checava o status da
  // própria offer — dava pra publicar o imóvel chamando este endpoint com o id de uma offer
  // PAUSED/CLOSED/SUPERSEDED (bastava o imóvel ter vídeo em algum PropertyMedia), inconsistente
  // com a invariante "publicado exige oferta ATIVA" aplicada em updateProperty/propertyOffers.
  if (offer.status !== 'ACTIVE') {
    throw AppError.conflict(
      'Só é possível publicar a partir de uma oferta ativa.',
      'PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER'
    );
  }

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

  // Guia do Marcelo §6/§7: "Publicação usa Motor de Regras para checar vídeo,
  // quantidade/qualidade de fotos, documentos e campos obrigatórios." A quantidade mínima
  // NÃO é hard-coded aqui (§18 "Não hard-code quantidade mínima de fotos/vídeo.") — o número
  // fica em REG-IMO-PHOTO-MIN.condition_ast_json.value, resolvido por evaluateRule.
  const approvedPhotoCount = await PropertyMedia.count({
    where: { propertyId: property.id, mediaType: 'PHOTO', qualityStatus: 'APPROVED' },
    transaction,
  });

  const photoEvaluation = await evaluateRule('REG-IMO-PHOTO-MIN', { approvedPhotoCount }, tenant, { transaction });
  if (photoEvaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Publicação bloqueada: quantidade mínima de fotos aprovadas não atingida.',
      'PROPERTY_PUBLISH_BLOCKED_REG_IMO_PHOTO_MIN',
      { ruleDecision: photoEvaluation.decision, reason: photoEvaluation.reason, approvedPhotoCount }
    );
  }

  // Documentos mínimos (matrícula/IPTU) — real_estate.property_documents (Caderno: "Matrícula,
  // IPTU etc.") — também resolvido via Motor de Regras (REG-IMO-DOCS-001), não hard-coded.
  const requiredDocTypes = ['REGISTRY', 'IPTU'];
  const existingDocTypes = new Set(
    (
      await PropertyDocument.findAll({
        where: { propertyId: property.id, documentType: requiredDocTypes },
        transaction,
      })
    ).map((doc) => doc.documentType)
  );
  const hasRequiredDocuments = requiredDocTypes.every((type) => existingDocTypes.has(type));

  const docsEvaluation = await evaluateRule('REG-IMO-DOCS-001', { hasRequiredDocuments }, tenant, { transaction });
  if (docsEvaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Publicação bloqueada: documentos mínimos (matrícula/IPTU) ausentes.',
      'PROPERTY_PUBLISH_BLOCKED_REG_IMO_DOCS_001',
      { ruleDecision: docsEvaluation.decision, reason: docsEvaluation.reason, missingDocTypes: requiredDocTypes.filter((t) => !existingDocTypes.has(t)) }
    );
  }

  property.publicationStatus = 'PUBLISHED';
  property.updatedBy = actorUserId || null;
  await property.save({ transaction });

  await publishPropertyPublished(property, transaction);

  return { property, offer };
}

module.exports = { publishOffer };
