'use strict';

const { PortalListing } = require('../../../models');

/** O anúncio ativo do imóvel no portal (travado para atualização), ou null. */
const findActive = (ctx, propertyId, connectionId, transaction) => PortalListing.findOne({
  where: { companyId: ctx.companyId, propertyId, connectionId, supersededAt: null }, transaction, lock: transaction.LOCK.UPDATE,
});

const createListing = (ctx, { propertyId, connectionId, mappingVersion }, transaction) => PortalListing.create({
  groupId: ctx.groupId, companyId: ctx.companyId, propertyId, connectionId, mappingVersion, status: 'PENDING_SYNC',
}, { transaction });

/** Os anúncios ativos do imóvel (todos os portais). */
const listActive = (ctx, propertyId, transaction) => PortalListing.findAll({
  where: { companyId: ctx.companyId, propertyId, supersededAt: null }, order: [['created_at', 'ASC']], transaction,
});

module.exports = { findActive, createListing, listActive };
