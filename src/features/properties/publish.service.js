'use strict';

const { Property, PropertyOffer } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishProperty } = require('./publicationGate.service');

/**
 * publishOffer — POST /offers/:id/publish (Guia do Marco 3 §13 "Publicar após gate"). A decisão é toda do gate único
 * (publicationGate.service.js): oferta ativa, vídeo e fotos aprovados, documentos e campos obrigatórios configurados, cada
 * checagem pelo Motor de Regras (fail-closed).
 */
async function publishOffer(offerId, tenant, actorUserId, transaction) {
  const offer = await PropertyOffer.findByPk(offerId, { transaction });
  if (!offer) throw AppError.notFound('Oferta não encontrada.', 'PROPERTY_OFFER_NOT_FOUND');
  const property = await Property.findByPk(offer.propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  await publishProperty(property, tenant, actorUserId, transaction, { offer, source: 'POST /offers/:id/publish' });
  return { property, offer };
}

module.exports = { publishOffer };
