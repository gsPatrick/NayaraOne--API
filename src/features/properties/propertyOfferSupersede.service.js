'use strict';

const { Op } = require('sequelize');
const { PropertyOffer } = require('../../models');

/**
 * supersedeCurrentActiveOffer — regra dura: uma property nunca pode ter duas offers ACTIVE do
 * mesmo `offerType` simultaneamente. Se já existir uma (ou mais) offer ACTIVE do mesmo tipo
 * (diferente de `excludeOfferId`, quando informado), ela(s) são marcadas SUPERSEDED na mesma
 * transação (atômico).
 */
async function supersedeCurrentActiveOffer({ propertyId, offerType, excludeOfferId, actorUserId }, transaction) {
  // FIX (homologação 22/09/2026 — auditoria proativa): usava `findOne`, que só pega a PRIMEIRA
  // offer ACTIVE encontrada. Não há constraint única no banco que impeça duas offers ACTIVE do
  // mesmo tipo coexistirem (ex.: corrida entre duas requisições de criação/atualização de offer
  // não serializadas), então se esse estado inválido já existisse, esta função silenciosamente
  // "resolvia" só uma das offers e deixava a(s) outra(s) ACTIVE — violando a própria invariante
  // que o comentário acima promete garantir. Trocado para um UPDATE em massa que fecha TODAS as
  // offers ACTIVE do tipo, não só a primeira.
  const where = { propertyId, offerType, status: 'ACTIVE' };
  if (excludeOfferId) {
    where.id = { [Op.ne]: excludeOfferId };
  }
  await PropertyOffer.update(
    { status: 'SUPERSEDED', updatedBy: actorUserId || null },
    { where, transaction }
  );
}

module.exports = { supersedeCurrentActiveOffer };
