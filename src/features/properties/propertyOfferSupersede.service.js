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
  //
  // FIX (homologação 23/09/2026 — auditoria adversarial de corrida): o UPDATE em massa acima
  // não bloqueava as linhas ACTIVE antes de decidir o que fechar. Duas requisições concorrentes
  // (dois corretores criando/reativando oferta pro mesmo imóvel ao mesmo tempo) podiam rodar o
  // supersede em paralelo sem uma enxergar o INSERT ainda não commitado da outra, e ambas
  // terminavam inserindo sua oferta como ACTIVE — duas offers ACTIVE do mesmo tipo pro mesmo
  // imóvel, quebrando a invariante. Agora a leitura das offers ACTIVE candidatas usa
  // `lock: transaction.LOCK.UPDATE` (SELECT ... FOR UPDATE) para serializar concorrentes antes
  // de decidir o que fechar.
  const where = { propertyId, offerType, status: 'ACTIVE' };
  if (excludeOfferId) {
    where.id = { [Op.ne]: excludeOfferId };
  }
  const toSupersede = await PropertyOffer.findAll({
    where,
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (toSupersede.length === 0) {
    return;
  }
  await PropertyOffer.update(
    { status: 'SUPERSEDED', updatedBy: actorUserId || null },
    { where: { id: toSupersede.map((offer) => offer.id) }, transaction }
  );
}

module.exports = { supersedeCurrentActiveOffer };
