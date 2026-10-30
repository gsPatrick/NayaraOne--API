'use strict';

const { registerDomainReaction } = require('../domain');
const { findPageById } = require('./site.store');
const { AGGREGATE, PAGE_STATUS, SYNC, PUBLISH, UNPUBLISH } = require('./site.constants');

const isPageEvent = (event) => {
  const p = event.payloadJson || {};
  return Boolean(p.aggregate && p.aggregate.type === AGGREGATE && p.aggregate.id) && [PUBLISH, UNPUBLISH].includes(p.operation);
};

/**
 * `integration.dispatch.confirmed` de uma página (M9-D259 3.2 item 3): SÓ AQUI a página vira PUBLISHED (envio de publicação) ou UNPUBLISHED (envio de retirada) e passa a SYNCED. Envio que
 * não é o corrente da página (um envio antigo confirmado tarde) não muda nada. Idempotente por evento; trava a página e relê o estado antes de decidir.
 */
async function onConfirmed(ctx, event, transaction) {
  if (!isPageEvent(event)) return null;
  const p = event.payloadJson;
  const page = await findPageById(ctx, p.aggregate.id, transaction);
  if (!page || page.dispatchId !== p.dispatchId) return null;
  const antes = { status: page.status, siteSyncStatus: page.siteSyncStatus };
  const agora = new Date();
  if (p.operation === PUBLISH) {
    await page.update({ status: PAGE_STATUS.PUBLISHED, siteSyncStatus: SYNC.SYNCED, publishedHash: page.contentHash, publishedAt: agora, lastError: null, dispatchConfirmed: true, appliedRank: Math.max(page.appliedRank, 1), appliedStatus: 'PUBLISHED' }, { transaction });
  } else {
    await page.update({ status: PAGE_STATUS.UNPUBLISHED, siteSyncStatus: SYNC.SYNCED, unpublishedAt: agora, lastError: null, dispatchConfirmed: true, appliedRank: Math.max(page.appliedRank, 1), appliedStatus: 'UNPUBLISHED' }, { transaction });
  }
  return { entity: { type: AGGREGATE, id: page.id }, before: antes, after: { status: page.status, siteSyncStatus: SYNC.SYNCED }, reason: `Envio ${p.dispatchId} confirmado pelo site: a página vai a ${page.status}.` };
}

/**
 * `integration.dispatch.failed` de uma página: o site não executou a operação. O estado interno NÃO é desfeito (INT-012): a página que estava PUBLISHED segue PUBLISHED e a que ainda não
 * tinha subido segue PENDING; só `site_sync_status` vira FAILED, com o erro em português, para a tela mostrar e uma pessoa (ou um novo pedido) reprocessar.
 */
async function onFailed(ctx, event, transaction) {
  if (!isPageEvent(event)) return null;
  const p = event.payloadJson;
  const page = await findPageById(ctx, p.aggregate.id, transaction);
  if (!page || page.dispatchId !== p.dispatchId || page.dispatchConfirmed) return null;
  const antes = { status: page.status, siteSyncStatus: page.siteSyncStatus };
  const patch = { siteSyncStatus: SYNC.FAILED, lastError: page.lastError || 'O site não executou a operação; o estado interno da página foi mantido.' };
  if (page.status === PAGE_STATUS.UNPUBLISHING) patch.status = PAGE_STATUS.PUBLISHED; // a retirada não aconteceu: a página segue no ar
  await page.update(patch, { transaction });
  return { entity: { type: AGGREGATE, id: page.id }, before: antes, after: { status: page.status, siteSyncStatus: SYNC.FAILED }, reason: `Envio ${p.dispatchId} falhou no site: o estado interno da página foi mantido.` };
}

let installed = false;
function installSiteReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'integrations.site.dispatch_confirmed', handler: onConfirmed });
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'integrations.site.dispatch_failed', handler: onFailed });
}

module.exports = { installSiteReactions, onConfirmed, onFailed };
