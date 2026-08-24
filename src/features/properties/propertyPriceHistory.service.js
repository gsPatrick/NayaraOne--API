'use strict';

const { PropertyPriceHistory } = require('../../models');
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

module.exports = { recordPriceHistory };
