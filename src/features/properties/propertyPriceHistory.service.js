'use strict';

const { PropertyPriceHistory, PropertyOffer, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { publishPropertyPriceChanged } = require('./propertyEvents.service');

/**
 * recordPriceHistory — grava append-only em "real_estate"."property_price_history" a cada
 * mudança de preço de uma offer. Nunca faz UPDATE do registro anterior (append-only por
 * design — auditoria de variação de preço ao longo do tempo). O histórico é vinculado à
 * OFERTA (offer_id), conforme confirmado pelo Caderno Técnico — não ao imóvel físico.
 */
async function recordPriceHistory(
  { groupId, companyId, offerId, oldPrice, newPrice, reasonCode, actorUserId },
  transaction
) {
  const history = await PropertyPriceHistory.create(
    {
      groupId,
      companyId,
      offerId,
      oldPrice: oldPrice !== undefined && oldPrice !== null ? oldPrice : null,
      newPrice,
      reasonCode: reasonCode || 'PRICE_UPDATE',
      changedAt: new Date(),
      changedBy: actorUserId,
    },
    { transaction }
  );

  await publishPropertyPriceChanged(history, transaction);

  return history;
}

/**
 * listPriceHistoryByProperty — leitura do histórico de preço de um imóvel. O histórico é
 * gravado por OFERTA (offer_id, ver acima), então aqui resolvemos primeiro as ofertas do
 * imóvel e devolvemos o histórico de todas elas em ordem cronológica decrescente — que é como
 * a linha do tempo de preço da ficha do imóvel apresenta a informação.
 */
async function listPriceHistoryByProperty(propertyId, transaction) {
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) throw AppError.notFound('Imóvel não encontrado.', 'PROPERTY_NOT_FOUND');

  const offers = await PropertyOffer.findAll({ where: { propertyId }, attributes: ['id'], transaction });
  const offerIds = offers.map((o) => o.id);
  if (offerIds.length === 0) return [];

  return PropertyPriceHistory.findAll({
    where: { offerId: offerIds },
    order: [['changed_at', 'DESC']],
    transaction,
  });
}

module.exports = { recordPriceHistory, listPriceHistoryByProperty };
