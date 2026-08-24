'use strict';

const { PropertyOffer, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { recordPriceHistory } = require('./propertyPriceHistory.service');
const { supersedeCurrentActiveOffer } = require('./propertyOfferSupersede.service');
const { publishPropertyOfferCreated } = require('./propertyEvents.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// CRUD de PropertyOffer — a geração append-only de histórico de preço vive em
// propertyPriceHistory.service.js e a regra de supersede de offer ACTIVE anterior vive em
// propertyOfferSupersede.service.js; este service apenas orquestra as duas coisas ao redor do CRUD.
//
// confidentialMinPrice NUNCA deve ser incluído em uma serialização servida a um contexto
// público (site/portais/IA pública) — para o admin/mock atual (tudo interno) retornamos o
// registro completo; toPublicOffer() abaixo é o ponto de extensão para quando existir uma rota
// pública real.

const OFFER_TYPES = ['SALE', 'RENT', 'SEASONAL'];
const OFFER_STATUSES = ['ACTIVE', 'SUPERSEDED', 'PAUSED', 'CLOSED'];

function toPublicOffer(offer) {
  const plain = offer.toJSON ? offer.toJSON() : offer;
  const { confidentialMinPrice, ...publicFields } = plain;
  return publicFields;
}

async function assertPropertyExists(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');
  return property;
}

async function createOffer(propertyId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { offerType, askingPrice, confidentialMinPrice, acceptsFinancing, acceptsTrade, status, startsAt, endsAt } = payload;

  if (!offerType || askingPrice === undefined || askingPrice === null) {
    throw AppError.badRequest('Os campos "offerType" e "askingPrice" são obrigatórios.', 'PROPERTY_OFFER_VALIDATION');
  }
  const normalizedType = String(offerType).toUpperCase();
  if (!OFFER_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "offerType" deve ser um de: ${OFFER_TYPES.join(', ')}.`, 'PROPERTY_OFFER_VALIDATION');
  }
  const normalizedStatus = status ? String(status).toUpperCase() : 'ACTIVE';
  if (!OFFER_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`O campo "status" deve ser um de: ${OFFER_STATUSES.join(', ')}.`, 'PROPERTY_OFFER_VALIDATION');
  }

  if (normalizedStatus === 'ACTIVE') {
    await supersedeCurrentActiveOffer({ propertyId, offerType: normalizedType, actorUserId }, transaction);
  }

  const offer = await PropertyOffer.create(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      propertyId,
      offerType: normalizedType,
      askingPrice,
      confidentialMinPrice: confidentialMinPrice !== undefined ? confidentialMinPrice : null,
      acceptsFinancing: acceptsFinancing !== undefined ? acceptsFinancing : null,
      acceptsTrade: acceptsTrade !== undefined ? acceptsTrade : null,
      status: normalizedStatus,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await recordPriceHistory(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      offerId: offer.id,
      oldPrice: null,
      newPrice: askingPrice,
      reasonCode: 'OFFER_CREATED',
      actorUserId,
    },
    transaction
  );

  await publishPropertyOfferCreated(offer, transaction);

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property_offer.create',
      entityType: 'PropertyOffer',
      entityId: offer.id,
      afterJson: offer.toJSON(),
      reason: `Oferta de ${normalizedType === 'RENT' ? 'locação' : normalizedType === 'SALE' ? 'venda' : 'temporada'} criada para o imóvel "${property.title}".`,
    },
    transaction
  );

  return offer;
}

async function listOffers(propertyId, transaction, filters = {}) {
  await assertPropertyExists(propertyId, transaction);
  const where = { propertyId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.offerType) where.offerType = String(filters.offerType).toUpperCase();
  return PropertyOffer.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOffer(propertyId, offerId, transaction) {
  const offer = await PropertyOffer.findOne({ where: { id: offerId, propertyId }, transaction });
  if (!offer) throw AppError.notFound('Oferta não encontrada.', 'PROPERTY_OFFER_NOT_FOUND');
  return offer;
}

/**
 * updateOffer — atualiza uma offer existente. Se `askingPrice` mudar, grava histórico
 * append-only automaticamente. Se `status` for alterado para ACTIVE, aplica a mesma regra de
 * supersede automático de qualquer outra offer ACTIVE do mesmo tipo (exceto ela mesma).
 */
async function updateOffer(propertyId, offerId, payload, actorUserId, transaction) {
  const property = await assertPropertyExists(propertyId, transaction);
  const offer = await getOffer(propertyId, offerId, transaction);
  const beforeJson = offer.toJSON();
  const { askingPrice, confidentialMinPrice, acceptsFinancing, acceptsTrade, status, startsAt, endsAt, reasonCode } = payload;

  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!OFFER_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`O campo "status" deve ser um de: ${OFFER_STATUSES.join(', ')}.`, 'PROPERTY_OFFER_VALIDATION');
    }
    if (normalizedStatus === 'ACTIVE' && offer.status !== 'ACTIVE') {
      await supersedeCurrentActiveOffer(
        { propertyId, offerType: offer.offerType, excludeOfferId: offer.id, actorUserId },
        transaction
      );
    }
    offer.status = normalizedStatus;
  }

  if (askingPrice !== undefined && Number(askingPrice) !== Number(offer.askingPrice)) {
    await recordPriceHistory(
      {
        groupId: property.groupId,
        companyId: property.companyId,
        offerId: offer.id,
        oldPrice: offer.askingPrice,
        newPrice: askingPrice,
        reasonCode: reasonCode || 'PRICE_UPDATE',
        actorUserId,
      },
      transaction
    );
    offer.askingPrice = askingPrice;
  }

  if (confidentialMinPrice !== undefined) offer.confidentialMinPrice = confidentialMinPrice;
  if (acceptsFinancing !== undefined) offer.acceptsFinancing = acceptsFinancing;
  if (acceptsTrade !== undefined) offer.acceptsTrade = acceptsTrade;
  if (startsAt !== undefined) offer.startsAt = startsAt;
  if (endsAt !== undefined) offer.endsAt = endsAt;
  offer.updatedBy = actorUserId || null;
  await offer.save({ transaction });

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property_offer.update',
      entityType: 'PropertyOffer',
      entityId: offer.id,
      beforeJson,
      afterJson: offer.toJSON(),
      reason: `Oferta do imóvel "${property.title}" atualizada.`,
    },
    transaction
  );

  return offer;
}

module.exports = { createOffer, listOffers, getOffer, updateOffer, toPublicOffer, OFFER_TYPES, OFFER_STATUSES };
