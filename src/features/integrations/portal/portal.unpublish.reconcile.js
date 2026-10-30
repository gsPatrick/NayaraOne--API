'use strict';

const { Op } = require('sequelize');
const { sequelize, PortalListing, IntegrationConnection } = require('../../../models');
const logger = require('../../../utils/logger');
const { tenantTx } = require('../dispatch/worker/tenantTx');
const { readPortalParams } = require('./portal.params');
const { syncOne } = require('./portal.sync');
const { ensurePortalAdaptersRegistered } = require('./portal.boot');
const { createRemovalDispatch, openRemoval } = require('./portal.unpublish');
const { escalateExhausted } = require('./portal.unpublish.exhausted');

const BATCH = 200;

/** Uma conferência de remoção vencida: lê o portal; confirmado, encerra; ainda ativo, reenvia (ou esgota). Roda num savepoint por anúncio. */
async function reconcileOne(ctx, listing, params, now, transaction) {
  await syncOne(ctx, listing.id, transaction);
  await listing.reload({ transaction });
  if (listing.status !== 'UNPUBLISHING') {
    await listing.update({ unpublishNextAttemptAt: null }, { transaction });
    return 'CONFIRMED';
  }
  if (listing.unpublishAttempts >= params.unpublishMaxAttempts) {
    const connection = await IntegrationConnection.findByPk(listing.connectionId, { attributes: ['providerCode'], transaction });
    await listing.update({ unpublishExhaustedAt: now, unpublishNextAttemptAt: null, lastError: 'A remoção esgotou as tentativas: o anúncio segue no ar no portal.' }, { transaction });
    await escalateExhausted(ctx, { id: listing.id, connectionId: listing.connectionId, providerCode: connection && connection.providerCode }, transaction, { attempts: listing.unpublishAttempts, now });
    return 'EXHAUSTED';
  }
  const tentativa = listing.unpublishAttempts + 1;
  // Um pedido ainda na fila (portal fora do ar, nova tentativa do worker) já vale como o reenvio: não se empilha outro.
  if (!(await openRemoval(ctx, listing.id, transaction))) await createRemovalDispatch(ctx, listing, tentativa, transaction);
  await listing.update({
    unpublishAttempts: tentativa, unpublishNextAttemptAt: new Date(now.getTime() + params.unpublishRetryIntervalMin * 60 * 1000),
    lastError: `Remoção sem confirmação do portal: reenvio ${tentativa} de ${params.unpublishMaxAttempts}.`,
  }, { transaction });
  return 'RESENT';
}

/**
 * reconcileUnpublishing — o job de reconciliação da despublicação (M9-D233 3.1 item 3). Para cada anúncio em UNPUBLISHING cuja conferência venceu (prazo de
 * `integration.portal.unpublish_confirm_deadline_min` depois do pedido, depois a cada `integration.portal.unpublish_retry_interval_min`): consulta o portal; se ainda mostra o
 * anúncio ativo, reenvia a remoção (SAFE e idempotente) até `integration.portal.unpublish_max_attempts` vezes, sem backoff crescente; esgotado, tarefa urgente e alerta HIGH uma
 * vez. Devolve { checked, confirmed, resent, exhausted }.
 */
async function reconcileUnpublishing({ group, company, now = new Date() }) {
  ensurePortalAdaptersRegistered();
  const ctx = { groupId: group.id, companyId: company.id, userId: null };
  return tenantTx(ctx, async (transaction) => {
    const params = await readPortalParams(ctx, transaction);
    const vencidos = await PortalListing.findAll({
      where: { companyId: ctx.companyId, status: 'UNPUBLISHING', supersededAt: null, unpublishExhaustedAt: null, unpublishNextAttemptAt: { [Op.lte]: now } },
      order: [['unpublish_next_attempt_at', 'ASC']], limit: BATCH, transaction, lock: transaction.LOCK.UPDATE,
    });
    const r = { checked: 0, confirmed: 0, resent: 0, exhausted: 0 };
    for (const listing of vencidos) {
      r.checked += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const desfecho = await sequelize.transaction({ transaction }, (savepoint) => reconcileOne(ctx, listing, params, now, savepoint));
        r[{ CONFIRMED: 'confirmed', RESENT: 'resent', EXHAUSTED: 'exhausted' }[desfecho]] += 1;
      } catch (err) {
        logger.warn({ listingId: listing.id, err: err.message, code: err.code }, 'Portal: a conferência da remoção falhou; segue na próxima rodada.');
      }
    }
    return r;
  });
}

module.exports = { reconcileUnpublishing };
