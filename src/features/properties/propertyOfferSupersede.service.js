'use strict';

const { Op } = require('sequelize');
const { PropertyOffer } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Substituição controlada de oferta (matriz M3-07; livro do Marco 3 §6 e CRMX-004): um imóvel nunca tem duas ofertas ACTIVE do
 * mesmo tipo. Em duas etapas, na mesma transação:
 *  1. supersedeCurrentActiveOffer — trava (SELECT ... FOR UPDATE) as ofertas ACTIVE do tipo (menos `excludeOfferId`) e as marca
 *     SUPERSEDED antes de a nova virar ACTIVE (o índice único parcial da migration 20260101000175 é a rede contra corrida);
 *  2. linkSupersededOffers — depois que a substituta existe, grava nela o vínculo (superseded_by_offer_id, superseded_at) e audita
 *     cada substituição com antes e depois (verificação independente de 11/11/2026: a substituição não era auditada nem dizia
 *     qual oferta a substituiu).
 * A oferta SUPERSEDED é final: não volta a ACTIVE nem muda de preço (propertyOffers.service.js recusa).
 */
async function supersedeCurrentActiveOffer({ propertyId, offerType, excludeOfferId, actorUserId }, transaction) {
  const where = { propertyId, offerType, status: 'ACTIVE' };
  if (excludeOfferId) where.id = { [Op.ne]: excludeOfferId };
  const toSupersede = await PropertyOffer.findAll({ where, transaction, lock: transaction.LOCK.UPDATE });
  if (toSupersede.length === 0) return [];
  const befores = toSupersede.map((offer) => offer.toJSON());
  await PropertyOffer.update(
    { status: 'SUPERSEDED', updatedBy: actorUserId || null },
    { where: { id: toSupersede.map((offer) => offer.id) }, transaction }
  );
  return befores;
}

async function linkSupersededOffers(befores, substitute, actorUserId, transaction) {
  const supersededAt = new Date();
  for (const beforeJson of befores) {
    await PropertyOffer.update(
      { supersededByOfferId: substitute.id, supersededAt, updatedBy: actorUserId || null },
      { where: { id: beforeJson.id }, transaction }
    );
    const after = await PropertyOffer.findByPk(beforeJson.id, { transaction });
    await registrarAuditoria(
      {
        groupId: substitute.groupId,
        companyId: substitute.companyId,
        actorUserId,
        action: 'property_offer.supersede',
        entityType: 'PropertyOffer',
        entityId: beforeJson.id,
        beforeJson,
        afterJson: after.toJSON(),
        reason: `Oferta ${beforeJson.id} (${beforeJson.offerType}) substituída pela oferta ${substitute.id}.`,
      },
      transaction
    );
  }
}

module.exports = { supersedeCurrentActiveOffer, linkSupersededOffers };
