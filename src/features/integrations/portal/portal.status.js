'use strict';

const crypto = require('node:crypto');
const { IntegrationDispatch } = require('../../../models');
const { publishDomainEvent } = require('../../../engines/events/outbox');
const { resolveDispatchByEvent } = require('../dispatch/reconcile');
const { LISTING_AGGREGATE, EVENT_STATUS_CHANGED } = require('./portal.constants');

/** Estado do anúncio a partir do estado que o portal informa (já normalizado pelo adapter). `null` = o estado informado não muda o anúncio. */
function nextStatus(current, external) {
  const s = String(external || '').toUpperCase();
  if (s === 'PUBLISHED' || s === 'UPDATED') return current === 'UNPUBLISHING' ? null : 'PUBLISHED'; // remoção pedida e o portal ainda mostra ativo: segue UNPUBLISHING (D233)
  if (s === 'UNPUBLISHED') return 'UNPUBLISHED';
  if (s === 'REJECTED') return 'REJECTED';
  return null;
}

/** O envio de publicação ou atualização mais recente do anúncio (o que o status do portal confirma ou reprova). */
const lastPublishDispatch = (ctx, listingId, transaction) => IntegrationDispatch.findOne({
  where: { companyId: ctx.companyId, aggregateType: LISTING_AGGREGATE, aggregateId: listingId, operation: ['publishListing', 'updateListing'] }, order: [['created_at', 'DESC']], transaction,
});

/** `properties.portal_listing.status_changed` na transação de quem mudou o estado (M9-D232 3.4). `key` distingue a mudança (a reação ao envio usa o id do envio, e o evento sai uma vez). */
async function publishStatusChanged(ctx, listing, { from, to, rejectionReason }, key, transaction) {
  return publishDomainEvent({
    groupId: ctx.groupId, companyId: ctx.companyId, aggregateType: 'Property', aggregateId: listing.propertyId, eventType: EVENT_STATUS_CHANGED,
    payload: { propertyId: listing.propertyId, listingId: listing.id, connectionId: listing.connectionId, externalListingId: listing.externalListingId || null, from, to, rejectionReason: rejectionReason || null },
    idempotencyKey: `${EVENT_STATUS_CHANGED}:${listing.id}:${from}:${to}:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`, // até 128 caracteres
  }, transaction);
}

/**
 * Aplica o estado que o portal informou (consulta de status ou webhook assinado, mesma regra de ordem): atualiza o anúncio, grava a reprovação em português e,
 * quando o estado mudou, publica `properties.portal_listing.status_changed` na mesma transação. O status também fecha o envio ligado (PUBLISHED confirma; REJECTED o dá como falho).
 * `external`: { status, rejectionReason?, externalListingId? }. Devolve { changed, from, to }.
 */
async function applyExternalListingStatus(ctx, listing, external, transaction) {
  const from = listing.status;
  const to = nextStatus(from, external.status) || from;
  const patch = { lastSyncedAt: new Date() };
  if (external.externalListingId && !listing.externalListingId) patch.externalListingId = external.externalListingId;
  if (to === 'REJECTED') {
    patch.rejectionReason = external.rejectionReason ? String(external.rejectionReason).slice(0, 200) : 'REJECTED_BY_PORTAL';
    patch.lastError = `O portal reprovou o anúncio: ${patch.rejectionReason}.`;
  } else if (to === 'PUBLISHED') {
    Object.assign(patch, { rejectionReason: null, lastError: null });
  }
  await listing.update({ ...patch, status: to }, { transaction });
  const s = String(external.status || '').toUpperCase();
  if (['PUBLISHED', 'UPDATED', 'REJECTED'].includes(s) && from !== 'UNPUBLISHING') {
    const envio = await lastPublishDispatch(ctx, listing.id, transaction);
    if (envio && ['SUBMITTED', 'UNKNOWN'].includes(envio.status)) {
      await resolveDispatchByEvent(ctx, { providerCode: envio.providerCode, idempotencyKey: envio.idempotencyKey, status: s === 'UPDATED' ? 'PUBLISHED' : s, source: 'STATUS_QUERY' }, {}, transaction);
    }
  }
  if (to !== from) await publishStatusChanged(ctx, listing, { from, to, rejectionReason: to === 'REJECTED' ? patch.rejectionReason : null }, `${Date.now()}`, transaction);
  return { changed: to !== from, from, to };
}

module.exports = { applyExternalListingStatus, nextStatus, lastPublishDispatch, publishStatusChanged };
