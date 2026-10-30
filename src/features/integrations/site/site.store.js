'use strict';

const { SitePage, IntegrationDispatch } = require('../../../models');

/** A página da empresa para a connection e a chave, travada para atualização, ou null. */
const findPage = (ctx, connectionId, pageKey, transaction) => SitePage.findOne({
  where: { companyId: ctx.companyId, connectionId, pageKey }, transaction, lock: transaction.LOCK.UPDATE,
});

const findPageById = (ctx, id, transaction) => SitePage.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/** O envio corrente da página. */
const currentDispatch = (ctx, page, transaction) => (page.dispatchId
  ? IntegrationDispatch.findOne({ where: { id: page.dispatchId, companyId: ctx.companyId }, transaction })
  : null);

module.exports = { findPage, findPageById, currentDispatch };
