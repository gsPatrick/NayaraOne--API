'use strict';

const { PortalListing } = require('../../../models');
const logger = require('../../../utils/logger');
const { registerEventConsumer } = require('../../../engines/events/consumers');
const adapterRegistry = require('../registry/adapterRegistry');
const { registerDomainHandler } = require('../webhooks/worker/worker.handlers');
const { applyExternalListingStatus } = require('./portal.status');
const { installPortalReactions } = require('./portal.react');
const { publishToPortals } = require('./portal.publish');
const { unpublishFromPortals } = require('./portal.unpublish');

const NAME = 'integrations.portal_listings';

/** O read model público mudou: cada anúncio existente compara o hash e, se mudou, atualiza no portal (M9-D232 3.3). Imóvel que deixou de ser publicável não chega aqui (é despublicação, M9-D233). */
async function onPublicChanged(event, transaction) {
  const ctx = { groupId: event.groupId, companyId: event.companyId, userId: null };
  const propertyId = event.payloadJson && event.payloadJson.propertyId;
  if (!propertyId) return { status: 'SKIPPED' };
  const vivos = await PortalListing.findAll({ where: { companyId: ctx.companyId, propertyId, supersededAt: null, status: ['PUBLISHING', 'PUBLISHED', 'REJECTED', 'ERROR', 'PENDING_SYNC'] }, attributes: ['connectionId'], transaction });
  if (!vivos.length) return { status: 'SKIPPED' };
  try {
    return await publishToPortals(ctx, { propertyId, connectionIds: vivos.map((v) => v.connectionId) }, transaction);
  } catch (err) {
    logger.warn({ propertyId, err: err.message, code: err.code }, 'Portais: a atualização dos anúncios pelo evento não pôde rodar.');
    return { status: 'FAILED' };
  }
}

/** O imóvel deixou de ser publicável (vendido, alugado, retirado, indisponível): o anúncio sai de todos os portais, cada um por um envio próprio (M9-D233 3.1 item 1). */
async function onPublicUnpublish(event, transaction) {
  const ctx = { groupId: event.groupId, companyId: event.companyId, userId: null };
  const propertyId = event.payloadJson && event.payloadJson.propertyId;
  return propertyId ? unpublishFromPortals(ctx, { propertyId }, transaction) : { status: 'SKIPPED' };
}

/** Webhook do portal (quando houver): mesma regra do sync de status, por id externo do anúncio. */
async function onPortalWebhook(ctx, row, ev, transaction) {
  const listing = ev.resourceRef ? await PortalListing.findOne({ where: { companyId: ctx.companyId, connectionId: row.connectionId, externalListingId: ev.resourceRef, supersededAt: null }, transaction, lock: transaction.LOCK.UPDATE }) : null;
  const adapter = adapterRegistry.instantiate(row.providerCode);
  const status = adapter && ev.externalStatus ? adapter.mapStatus(ev.externalStatus) : null;
  if (!listing || !status) return { applied: false };
  const r = await applyExternalListingStatus(ctx, listing, { status, rejectionReason: ev.data && ev.data.rejectionReason }, transaction);
  return { applied: r.changed };
}

let installed = false;
function installPortalEvents() {
  if (installed) return;
  installed = true;
  registerEventConsumer('property.public.changed', NAME, onPublicChanged);
  registerEventConsumer('property.public.unpublish', `${NAME}.unpublish`, onPublicUnpublish);
  registerDomainHandler('PORTAL', onPortalWebhook);
  installPortalReactions(); // M9-D220: a reação ao envio confirmado ou falho (e a compensação)
}

module.exports = { installPortalEvents, onPublicChanged, onPublicUnpublish, onPortalWebhook, NAME };
