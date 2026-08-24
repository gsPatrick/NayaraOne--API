'use strict';

const { PropertyOffer } = require('../../models');

/**
 * supersedeCurrentActiveOffer — regra dura: uma property nunca pode ter duas offers ACTIVE do
 * mesmo `offerType` simultaneamente. Se já existir uma offer ACTIVE do mesmo tipo (diferente de
 * `excludeOfferId`, quando informado), ela é marcada SUPERSEDED na mesma transação (atômico).
 */
async function supersedeCurrentActiveOffer({ propertyId, offerType, excludeOfferId, actorUserId }, transaction) {
  const currentActive = await PropertyOffer.findOne({
    where: { propertyId, offerType, status: 'ACTIVE' },
    transaction,
  });
  if (currentActive && currentActive.id !== excludeOfferId) {
    currentActive.status = 'SUPERSEDED';
    currentActive.updatedBy = actorUserId || null;
    await currentActive.save({ transaction });
  }
}

module.exports = { supersedeCurrentActiveOffer };
