'use strict';

const { sequelize, PortalListing, IntegrationDispatch, IntegrationConnection } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { createMinimizedDispatch } = require('../minimization');
const { transitionDispatch } = require('../dispatch/dispatch.transition');
const { readPortalParams } = require('./portal.params');
const { lastPublishDispatch } = require('./portal.status');
const { summarize } = require('./portal.publish');
const { LISTING_AGGREGATE } = require('./portal.constants');

const OPEN_DISPATCH = ['PENDING', 'RETRY_WAIT', 'SENDING'];
const PENDING_REMOVAL = Object.freeze({ code: 'INTEGRATION_PORTAL_PARTIAL_PROGRESS', message: 'Remoção iniciada: acompanhe o status de cada portal.' });

/** Pedido de remoção ao portal (SAFE e idempotente): um envio por tentativa, com a chave `portal:unpublish:<vínculo>:<tentativa>`. */
const createRemovalDispatch = (ctx, listing, attempt, transaction) => createMinimizedDispatch(ctx, {
  connectionId: listing.connectionId, operation: 'unpublishListing', idempotencyKey: `portal:unpublish:${listing.id}:${attempt}`, criticalityOp: 'SAFE',
  domainObject: { externalResourceId: listing.externalListingId }, aggregateType: LISTING_AGGREGATE, aggregateId: listing.id,
}, transaction);

/** Envios de remoção ainda na fila (não saíram ou esperam nova tentativa) do anúncio. */
const openRemoval = (ctx, listingId, transaction) => IntegrationDispatch.findOne({
  where: { companyId: ctx.companyId, aggregateType: LISTING_AGGREGATE, aggregateId: listingId, operation: 'unpublishListing', status: OPEN_DISPATCH }, transaction,
});

const audit = (ctx, listing, antes, depois, reason, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: 'integration.portal_listing.unpublish_requested', entityType: 'PortalListing', entityId: listing.id,
  beforeJson: antes, afterJson: depois, reason,
}, transaction);

const toItem = (listing, extra = {}) => ({
  connectionId: listing.connectionId, listingId: listing.id, status: listing.status, externalListingId: listing.externalListingId || null, dispatchId: null, noop: false, ...extra,
});

/** Anúncio que nunca chegou ao portal (sem id externo): a remoção é só cancelar o envio que ainda esperava na fila e dar o vínculo como removido. */
async function dropUnsent(ctx, listing, antes, transaction) {
  const abertos = await IntegrationDispatch.findAll({
    where: { companyId: ctx.companyId, aggregateType: LISTING_AGGREGATE, aggregateId: listing.id, operation: ['publishListing', 'updateListing'], status: ['PENDING', 'RETRY_WAIT'] }, transaction,
  });
  for (const d of abertos) {
    // eslint-disable-next-line no-await-in-loop
    await transitionDispatch(ctx, d.id, 'CANCELLED', {}, { motivo: 'Imóvel despublicado antes de o anúncio sair para o portal.' }, transaction);
  }
  await listing.update({ status: 'UNPUBLISHED', unpublishNextAttemptAt: null, lastError: null }, { transaction });
  await audit(ctx, listing, antes, { status: 'UNPUBLISHED' }, 'Anúncio que não chegou ao portal: removido sem chamar o portal.', transaction);
  return toItem(listing);
}

async function unpublishOne(ctx, listing, transaction) {
  const antes = { status: listing.status, unpublishAttempts: listing.unpublishAttempts };
  if (['UNPUBLISHED', 'UNPUBLISHING'].includes(listing.status)) return toItem(listing, { noop: true });
  if (!listing.externalListingId) {
    const envio = await lastPublishDispatch(ctx, listing.id, transaction);
    if (envio && envio.externalResourceId) await listing.update({ externalListingId: envio.externalResourceId }, { transaction });
  }
  if (!listing.externalListingId) return dropUnsent(ctx, listing, antes, transaction);
  const params = await readPortalParams(ctx, transaction);
  const agora = new Date();
  await listing.update({
    status: 'UNPUBLISHING', unpublishRequestedAt: agora, unpublishAttempts: 0, unpublishExhaustedAt: null, unpublishNextAttemptAt: new Date(agora.getTime() + params.unpublishConfirmDeadlineMin * 60 * 1000), lastError: null,
  }, { transaction });
  const { dispatch } = await createRemovalDispatch(ctx, listing, 0, transaction);
  await audit(ctx, listing, antes, { status: 'UNPUBLISHING', unpublishRequestedAt: agora }, 'Remoção do anúncio pedida ao portal: o anúncio só sai de UNPUBLISHING quando o portal confirmar.', transaction);
  return toItem(listing, { dispatchId: dispatch.id });
}

/**
 * unpublishFromPortals — despublica o imóvel (vendido, alugado, retirado ou pedido do usuário) em cada portal onde ele tem anúncio (M9-D233 3.1): um envio `unpublishListing` por
 * vínculo, que passa a UNPUBLISHING e só vira UNPUBLISHED quando o portal confirma (consulta de status ou webhook, nunca pela resposta 200). Cada portal é independente: erro de um
 * vai para `last_error` do vínculo dele e não altera os outros. Devolve { total, published, items, code, message } (a operação do usuário responde 202 com a lista por portal).
 */
async function unpublishFromPortals(ctx, { propertyId, connectionIds } = {}, transaction) {
  const where = { companyId: ctx.companyId, propertyId, supersededAt: null };
  if (Array.isArray(connectionIds) && connectionIds.length) where.connectionId = connectionIds;
  const vinculos = await PortalListing.findAll({ where, order: [['created_at', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const portais = new Map((await IntegrationConnection.findAll({ where: { id: vinculos.map((v) => v.connectionId) }, attributes: ['id', 'providerCode'], transaction })).map((c) => [c.id, c.providerCode]));
  const items = [];
  for (const listing of vinculos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      items.push({ ...(await sequelize.transaction({ transaction }, (savepoint) => unpublishOne(ctx, listing, savepoint))), providerCode: portais.get(listing.connectionId) });
    } catch (err) {
      logger.warn({ listingId: listing.id, err: err.message, code: err.code }, 'Portal: a remoção deste portal falhou; os demais seguem.');
      await listing.update({ lastError: `Não foi possível pedir a remoção ao portal: ${String(err.message).slice(0, 200)}` }, { transaction });
      items.push(toItem(listing, { providerCode: portais.get(listing.connectionId), error: err.code || 'INTEGRATION_PORTAL_UNPUBLISH_FAILED' }));
    }
  }
  return { ...summarize(items), ...PENDING_REMOVAL };
}

module.exports = { unpublishFromPortals, createRemovalDispatch, openRemoval, PENDING_REMOVAL };
