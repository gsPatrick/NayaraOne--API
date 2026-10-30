'use strict';

const logger = require('../../../utils/logger');
const { sequelize, PortalListing, IntegrationConnection } = require('../../../models');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const { createPropertyPublicationDispatch } = require('../publication');
const { findActive } = require('../contingency/contingency.state');
const { readPortalParams } = require('./portal.params');
const { lastPublishDispatch } = require('./portal.status');
const { dispatchKey } = require('./portal.publish');

const QUEUED = ['PENDING', 'RETRY_WAIT'];
const REFUSED = ['FAILED', 'CANCELLED', 'DEAD_LETTER'];
const LOTE = 200;

/** Um anúncio PENDING_SYNC: recria o envio se o anterior foi recusado de vez e adianta o que está esperando há mais que o intervalo. */
async function reprocessOne(ctx, listing, params, now, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: listing.connectionId, companyId: ctx.companyId }, transaction });
  if (!connection || connection.status !== 'ACTIVE' || !listing.payloadHash) return null;
  if (await findActive(ctx, { connectionId: connection.id }, transaction)) return null; // portal ainda fora: quem solta a fila é a recuperação da contingência (M9-D226)
  const ultimo = await lastPublishDispatch(ctx, listing.id, transaction);
  const operation = listing.externalListingId ? 'updateListing' : 'publishListing';
  if (!ultimo || REFUSED.includes(ultimo.status)) {
    await createPropertyPublicationDispatch(ctx, {
      connectionId: connection.id, propertyId: listing.propertyId, operation, idempotencyKey: await dispatchKey(ctx, listing, operation, listing.payloadHash, transaction), externalResourceId: listing.externalListingId || undefined,
      aggregateType: 'PortalListing', aggregateId: listing.id,
    }, transaction);
    return 'republished';
  }
  const parado = now.getTime() - new Date(ultimo.updatedAt).getTime() >= params.reconcileIntervalMin * 60000;
  if (QUEUED.includes(ultimo.status) && parado && ultimo.nextAttemptAt && new Date(ultimo.nextAttemptAt) > now) {
    await sequelize.query('UPDATE "integration"."dispatches" SET next_attempt_at = :now WHERE id = :id', { replacements: { now, id: ultimo.id }, transaction });
    return 'nudged';
  }
  return null;
}

/**
 * Reprocessa os anúncios PENDING_SYNC a cada rodada do sync de status (que roda a cada `integration.portal.reconcile_interval_min`, M9-D227 3.2) até o portal aceitar: o envio recusado de
 * vez é recriado (mesmo conteúdo, chave com sufixo) e o que espera uma nova tentativa há mais que o intervalo é adiantado. Um anúncio nunca bloqueia o outro. Devolve { republished, nudged }.
 */
async function reprocessPendingSync(ctx, now = new Date()) {
  const resumo = { republished: 0, nudged: 0 };
  const ids = await tenantTx(ctx, async (transaction) => (await PortalListing.findAll({
    where: { companyId: ctx.companyId, supersededAt: null, status: 'PENDING_SYNC' }, attributes: ['id'], order: [['pending_sync_since', 'ASC']], limit: LOTE, transaction,
  })).map((l) => l.id));
  for (const id of ids) {
    try {
      const r = await tenantTx(ctx, async (transaction) => {
        const listing = await PortalListing.findOne({ where: { id, companyId: ctx.companyId, status: 'PENDING_SYNC' }, transaction, lock: transaction.LOCK.UPDATE });
        const params = await readPortalParams(ctx, transaction);
        return listing ? reprocessOne(ctx, listing, params, now, transaction) : null;
      });
      if (r) resumo[r] += 1;
    } catch (err) {
      logger.warn({ listingId: id, err: err.message, code: err.code }, 'Portais: o reprocessamento do anúncio pendente falhou; os demais seguem.');
    }
  }
  return resumo;
}

module.exports = { reprocessPendingSync };
