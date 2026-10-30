'use strict';

const { PortalListing } = require('../../../models');
const { registerDomainReaction, compensateDispatch } = require('../domain');
const { lastPublishDispatch, publishStatusChanged } = require('./portal.status');
const { LISTING_AGGREGATE } = require('./portal.constants');

const PUBLISH_OPS = ['publishListing', 'updateListing'];

/** Evento de envio de um anúncio de portal (aggregate PortalListing e operação do port), ou null. */
const listingEvent = (event, operations) => {
  const p = event.payloadJson || {};
  return p.dispatchId && p.aggregate && p.aggregate.type === LISTING_AGGREGATE && p.aggregate.id && operations.includes(p.operation) ? p : null;
};

const lockListing = (ctx, id, transaction) => PortalListing.findOne({ where: { id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/**
 * `integration.dispatch.confirmed` de um anúncio (M9-D232 + M9-D220 3.1 itens 2 e 5). SÓ por este evento (e pelo status que o portal informa, portal.status) o anúncio sai de PUBLISHING:
 *  - PUBLISHING e este é o último envio de publicação: o anúncio vira PUBLISHED, guarda o id externo e `properties.portal_listing.status_changed` sai uma vez;
 *  - UNPUBLISHED (a remoção foi dada como feita antes de a publicação em voo chegar ao portal): o portal agora mostra um anúncio que o ERP já retirou, e a COMPENSAÇÃO é um novo
 *    envio `unpublishListing` (compensateDispatch) sobre o mesmo anúncio externo; o envio de publicação original não é alterado;
 *  - em UNPUBLISHING a remoção em curso já cuida do anúncio (nada a fazer); qualquer outro estado não muda.
 */
async function onConfirmed(ctx, event, transaction) {
  const p = listingEvent(event, PUBLISH_OPS);
  if (!p) return null;
  const listing = await lockListing(ctx, p.aggregate.id, transaction);
  if (!listing || listing.supersededAt) return null;
  if (listing.status === 'UNPUBLISHED') {
    if (p.operation !== 'publishListing') return null; // a atualização de um anúncio já retirado não tem compensação: a publicação que o criou é que se desfaz
    const r = await compensateDispatch(ctx, p.dispatchId, { transaction });
    return { entity: { type: LISTING_AGGREGATE, id: listing.id }, before: { status: listing.status }, after: { status: listing.status, compensationDispatchId: r.dispatch.id },
      reason: `Envio ${p.dispatchId} confirmado pelo portal depois da remoção do anúncio: remoção compensatória pedida (envio ${r.dispatch.id}).` };
  }
  if (listing.status !== 'PUBLISHING') return null;
  const ultimo = await lastPublishDispatch(ctx, listing.id, transaction);
  if (!ultimo || ultimo.id !== p.dispatchId) return null;
  const patch = { status: 'PUBLISHED', rejectionReason: null, lastError: null, lastSyncedAt: new Date() };
  if (!listing.externalListingId && p.externalResourceId) patch.externalListingId = String(p.externalResourceId).slice(0, 160);
  await listing.update(patch, { transaction });
  await publishStatusChanged(ctx, listing, { from: 'PUBLISHING', to: 'PUBLISHED' }, p.dispatchId, transaction);
  return { entity: { type: LISTING_AGGREGATE, id: listing.id }, before: { status: 'PUBLISHING' }, after: { status: 'PUBLISHED' }, reason: `Envio ${p.dispatchId} confirmado pelo portal: o anúncio vai a PUBLISHED.` };
}

/**
 * `integration.dispatch.failed` de um anúncio: o portal não executou a operação (recusa, credencial, tentativas esgotadas). Falha ou ausência de resposta NUNCA desfaz o que o portal já
 * mostra:
 *  - publicação que nunca chegou ao portal (PUBLISHING sem id externo): vai a ERROR, com o motivo em português, para o corretor corrigir e publicar de novo (republicar sai do ERROR);
 *  - atualização recusada (anúncio com id externo): o anúncio anterior segue no ar (PUBLISHED) e `last_error` explica;
 *  - remoção recusada: segue UNPUBLISHING (a conferência da D233 reenvia) e `last_error` registra.
 * Só envio corrente do anúncio conta (um envio antigo que falha tarde não muda nada).
 */
async function onFailed(ctx, event, transaction) {
  const p = listingEvent(event, [...PUBLISH_OPS, 'unpublishListing']);
  if (!p) return null;
  const listing = await lockListing(ctx, p.aggregate.id, transaction);
  if (!listing || listing.supersededAt) return null;
  if (PUBLISH_OPS.includes(p.operation)) {
    const ultimo = await lastPublishDispatch(ctx, listing.id, transaction);
    if (!ultimo || ultimo.id !== p.dispatchId) return null;
  }
  const antes = { status: listing.status, lastError: listing.lastError };
  const classe = (event.payloadJson || {}).errorClass || 'ERROR';
  let status = listing.status;
  let erro;
  if (p.operation === 'unpublishListing') {
    erro = 'O portal não aceitou o pedido de remoção: a remoção segue em conferência e será pedida de novo.';
  } else if (listing.status === 'PUBLISHING' && !listing.externalListingId) {
    status = 'ERROR';
    erro = `O portal não aceitou o anúncio (${classe}): confira os dados do imóvel e publique de novo.`;
  } else {
    if (listing.status === 'PUBLISHING') status = 'PUBLISHED';
    erro = `O portal não aceitou a atualização (${classe}): o anúncio anterior segue no ar.`;
  }
  await listing.update({ status, lastError: erro }, { transaction });
  if (status !== antes.status) await publishStatusChanged(ctx, listing, { from: antes.status, to: status }, p.dispatchId, transaction);
  return { entity: { type: LISTING_AGGREGATE, id: listing.id }, before: antes, after: { status, lastError: erro }, reason: `Envio ${p.dispatchId} (${p.operation}) falhou no portal.` };
}

let installed = false;
function installPortalReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'integrations.portal.dispatch_confirmed', handler: onConfirmed });
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'integrations.portal.dispatch_failed', handler: onFailed });
}

module.exports = { installPortalReactions, onConfirmed, onFailed };
