'use strict';

const { PropertyOffer, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { recordPriceHistory } = require('./propertyPriceHistory.service');
const { supersedeCurrentActiveOffer, linkSupersededOffers } = require('./propertyOfferSupersede.service');
const { publishPropertyOfferCreated, publishPropertyPublicSourceChanged, publishPropertyOfferStatusChanged } = require('./propertyEvents.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
// M3-22 (CRMX-007): o matching do Radar com o imóvel roda POR EVENTO no despacho do outbox (radarEventConsumers.js), a partir de
// property.offer.created, property.price.changed e property.offer.status.changed publicados aqui na mesma transação.

// CRUD de PropertyOffer — a geração append-only de histórico de preço vive em
// propertyPriceHistory.service.js e a regra de supersede de offer ACTIVE anterior vive em
// propertyOfferSupersede.service.js; este service apenas orquestra as duas coisas ao redor do CRUD.
//
// confidentialMinPrice (preço mínimo confidencial): o escopo padrão de PropertyOffer não o lê; só quem tem a permissão
// específica properties:internal o vê e o grava (verificação independente de 11/11/2026, M3-07; DI-M3IM-4). `options.canSeeConfidential`
// vem do controller (req.auth.permissions). toPublicOffer() continua tirando o campo de qualquer serialização pública.

const OFFER_TYPES = ['SALE', 'RENT', 'SEASONAL'];
const OFFER_STATUSES = ['ACTIVE', 'SUPERSEDED', 'PAUSED', 'CLOSED'];
const CONFIDENTIAL_PERMISSION = 'properties:internal';
const CONDITIONS_MAX = 4000;

const offerModel = (options = {}) => (options.canSeeConfidential ? PropertyOffer.scope('withConfidentialPrice') : PropertyOffer);

function assertConfidentialWrite(payload, options = {}) {
  if (payload.confidentialMinPrice !== undefined && !options.canSeeConfidential) {
    throw AppError.forbidden(`O preço mínimo confidencial só pode ser informado por quem tem a permissão ${CONFIDENTIAL_PERMISSION}.`, 'PROPERTY_CONFIDENTIAL_PRICE_FORBIDDEN');
  }
}

// Livro §6: a oferta guarda as "condições" (texto livre: entrada, prazo, reajuste, o que está incluso...).
function normalizeConditions(conditions) {
  if (conditions === undefined) return undefined;
  if (conditions === null || String(conditions).trim() === '') return null;
  if (typeof conditions !== 'string' || conditions.length > CONDITIONS_MAX) {
    throw AppError.badRequest(`O campo "conditions" deve ser um texto de até ${CONDITIONS_MAX} caracteres.`, 'PROPERTY_OFFER_VALIDATION');
  }
  return conditions.trim();
}

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

async function createOffer(propertyId, payload, actorUserId, transaction, options = {}) {
  const property = await assertPropertyExists(propertyId, transaction);
  const { offerType, askingPrice, confidentialMinPrice, acceptsFinancing, acceptsTrade, status, startsAt, endsAt } = payload;
  assertConfidentialWrite(payload, options);
  const conditions = normalizeConditions(payload.conditions);

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
  if (normalizedStatus === 'SUPERSEDED') {
    throw AppError.badRequest('Uma oferta não nasce substituída: SUPERSEDED só é gravado pela substituição controlada.', 'PROPERTY_OFFER_STATUS_SUPERSEDED_MANUAL');
  }

  const supersededBefore = normalizedStatus === 'ACTIVE'
    ? await supersedeCurrentActiveOffer({ propertyId, offerType: normalizedType, actorUserId }, transaction)
    : [];

  // FIX (homologação 23/09/2026 — auditoria adversarial): supersedeCurrentActiveOffer +
  // FOR UPDATE fecham a corrida quando já existe uma offer ACTIVE pra travar, mas a constraint
  // única parcial (migration 20260101000175) é quem garante de verdade a invariante no caso
  // residual (ex.: primeira offer ACTIVE do tipo, nada pra travar via FOR UPDATE). Se a
  // constraint disparar (corrida real, janela mínima), converte pro mesmo formato de erro de
  // negócio do resto do projeto em vez de vazar um 500 de constraint de banco.
  let offer;
  try {
    offer = await PropertyOffer.create(
      {
        groupId: property.groupId,
        companyId: property.companyId,
        propertyId,
        offerType: normalizedType,
        askingPrice,
        confidentialMinPrice: confidentialMinPrice !== undefined ? confidentialMinPrice : null,
        acceptsFinancing: acceptsFinancing !== undefined ? acceptsFinancing : null,
        acceptsTrade: acceptsTrade !== undefined ? acceptsTrade : null,
        conditions: conditions === undefined ? null : conditions,
        status: normalizedStatus,
        startsAt: startsAt || null,
        endsAt: endsAt || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Já existe uma oferta ACTIVE deste tipo para este imóvel (corrida concorrente detectada) — tente novamente.',
        'PROPERTY_OFFER_ACTIVE_RACE'
      );
    }
    throw err;
  }

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

  await linkSupersededOffers(supersededBefore, offer, actorUserId, transaction);
  await publishPropertyOfferCreated(offer, transaction);

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property_offer.create',
      entityType: 'PropertyOffer',
      entityId: offer.id,
      afterJson: { ...offer.toJSON(), supersededOfferIds: supersededBefore.map((o) => o.id) },
      reason: `Oferta de ${normalizedType === 'RENT' ? 'locação' : normalizedType === 'SALE' ? 'venda' : 'temporada'} criada para o imóvel "${property.title}".`,
    },
    transaction
  );

  // CRMX-007: o matching do Radar sai do evento publicado acima (radar/radarEventConsumers.js), não de chamada direta.
  return offerModel(options).findByPk(offer.id, { transaction });
}

async function listOffers(propertyId, transaction, filters = {}, options = {}) {
  await assertPropertyExists(propertyId, transaction);
  const where = { propertyId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.offerType) where.offerType = String(filters.offerType).toUpperCase();
  return offerModel(options).findAll({ where, order: [['created_at', 'DESC']], transaction });
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
 *
 * CRM-TS-014 ("Price race — 2 alterações simultâneas — Lock/version history correto"): a
 * leitura usa SELECT ... FOR UPDATE (mesmo padrão FOR UPDATE já usado no resto do projeto —
 * ver opportunity.service.js). Sem o lock, duas transações concorrentes liam o mesmo
 * `askingPrice` em memória ANTES de qualquer uma commitar; cada uma gravava um
 * PropertyPriceHistory com o mesmo `oldPrice` (o valor pré-corrida), então o histórico
 * passava a impressão de duas mudanças paralelas a partir do mesmo preço-base, quando na
 * verdade uma delas já tinha sido sobrescrita — o "version history correto" do requisito.
 * Com o lock, a segunda transação só lê a linha depois da primeira commitar, então grava o
 * `oldPrice` real (o preço que a primeira transação deixou), preservando a cadeia exata.
 */
async function updateOffer(propertyId, offerId, payload, actorUserId, transaction, options = {}) {
  const property = await assertPropertyExists(propertyId, transaction);
  assertConfidentialWrite(payload, options);
  const offer = await PropertyOffer.findOne({
    where: { id: offerId, propertyId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!offer) throw AppError.notFound('Oferta não encontrada.', 'PROPERTY_OFFER_NOT_FOUND');
  // Substituição controlada (M3-07): a oferta SUPERSEDED é histórico — não volta a ACTIVE nem muda; para vender/alugar de novo,
  // cria-se uma oferta nova (que substitui a ACTIVE do tipo, se houver).
  if (offer.status === 'SUPERSEDED') {
    throw AppError.conflict('Esta oferta foi substituída e não pode mais ser alterada nem reativada. Crie uma nova oferta.', 'PROPERTY_OFFER_SUPERSEDED_FINAL', { supersededByOfferId: offer.supersededByOfferId });
  }
  const beforeJson = offer.toJSON();
  const { askingPrice, confidentialMinPrice, acceptsFinancing, acceptsTrade, status, startsAt, endsAt, reasonCode } = payload;
  const conditions = normalizeConditions(payload.conditions);
  let supersededBefore = [];

  // FIX AUD-2026-09-14 (reportado pela cliente: imóvel aparece simultaneamente como
  // "Publicado" e "Sem oferta"): ao pausar/encerrar a ÚLTIMA offer ACTIVE de um imóvel,
  // nada revertia property.publicationStatus — o imóvel ficava PUBLISHED pra sempre, mesmo
  // sem nenhuma offer ACTIVE por trás. Agora, se essa era a offer ACTIVE que sustentava a
  // publicação e não sobra nenhuma outra ACTIVE, o imóvel volta para INACTIVE.
  const wasActive = offer.status === 'ACTIVE';
  const statusBefore = offer.status;

  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!OFFER_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`O campo "status" deve ser um de: ${OFFER_STATUSES.join(', ')}.`, 'PROPERTY_OFFER_VALIDATION');
    }
    if (normalizedStatus === 'SUPERSEDED') {
      throw AppError.badRequest('SUPERSEDED só é gravado pela substituição controlada (nova oferta ativa do mesmo tipo).', 'PROPERTY_OFFER_STATUS_SUPERSEDED_MANUAL');
    }
    if (normalizedStatus === 'ACTIVE' && offer.status !== 'ACTIVE') {
      supersededBefore = await supersedeCurrentActiveOffer(
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
  if (conditions !== undefined) offer.conditions = conditions;
  if (startsAt !== undefined) offer.startsAt = startsAt;
  if (endsAt !== undefined) offer.endsAt = endsAt;
  offer.updatedBy = actorUserId || null;
  try {
    await offer.save({ transaction });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Já existe uma oferta ACTIVE deste tipo para este imóvel (corrida concorrente detectada) — tente novamente.',
        'PROPERTY_OFFER_ACTIVE_RACE'
      );
    }
    throw err;
  }
  await linkSupersededOffers(supersededBefore, offer, actorUserId, transaction);

  if (wasActive && offer.status !== 'ACTIVE' && property.publicationStatus === 'PUBLISHED') {
    const remainingActive = await PropertyOffer.count({
      where: { propertyId, status: 'ACTIVE' },
      transaction,
    });
    if (remainingActive === 0) {
      const propertyBeforeJson = property.toJSON();
      property.publicationStatus = 'INACTIVE';
      property.updatedBy = actorUserId || null;
      await property.save({ transaction });
      await registrarAuditoria(
        {
          groupId: property.groupId,
          companyId: property.companyId,
          actorUserId,
          action: 'property.auto_unpublish',
          entityType: 'Property',
          entityId: property.id,
          beforeJson: propertyBeforeJson,
          afterJson: property.toJSON(),
          reason: `Imóvel "${property.title}" despublicado automaticamente — a última offer ACTIVE (${offer.id}) foi alterada para ${offer.status}, sem nenhuma outra offer ACTIVE restante.`,
        },
        transaction
      );
    }
  }

  await registrarAuditoria(
    {
      groupId: property.groupId,
      companyId: property.companyId,
      actorUserId,
      action: 'property_offer.update',
      entityType: 'PropertyOffer',
      entityId: offer.id,
      beforeJson,
      afterJson: { ...offer.toJSON(), supersededOfferIds: supersededBefore.map((o) => o.id) },
      reason: `Oferta do imóvel "${property.title}" atualizada.`,
    },
    transaction
  );

  if (offer.status !== statusBefore) await publishPropertyOfferStatusChanged(offer, statusBefore, transaction);
  await publishPropertyPublicSourceChanged(property, transaction);
  return offerModel(options).findByPk(offer.id, { transaction });
}

module.exports = { createOffer, listOffers, getOffer, updateOffer, toPublicOffer, OFFER_TYPES, OFFER_STATUSES, CONFIDENTIAL_PERMISSION };
