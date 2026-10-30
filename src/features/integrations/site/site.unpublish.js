'use strict';

const AppError = require('../../../utils/AppError');
const { createMinimizedDispatch } = require('../minimization');
const { transitionDispatch } = require('../dispatch/dispatch.transition');
const { IntegrationDispatch } = require('../../../models');
const { findPageById } = require('./site.store');
const { audit, view } = require('./site.publish');
const { AGGREGATE, UNPUBLISH, PUBLISH, PAGE_STATUS, SYNC } = require('./site.constants');

/**
 * unpublishSitePage — retira a página do site (M9-D259 3.2). A remoção é idempotente (SAFE): a página vai a UNPUBLISHING e só vira UNPUBLISHED quando o site confirma por status; pedir de novo
 * enquanto a remoção está em andamento não cria outro envio; página já retirada: no-op. Página que nunca chegou ao site (nenhum envio saiu): os envios que esperavam na fila são cancelados e
 * a página vira UNPUBLISHED sem chamar o site. `args`: { pageId }.
 */
async function unpublishSitePage(ctx, { pageId }, transaction) {
  const page = await findPageById(ctx, pageId, transaction);
  if (!page) throw AppError.notFound('Página do site não encontrada.', 'INTEGRATION_SITE_PAGE_NOT_FOUND');
  if ([PAGE_STATUS.UNPUBLISHED, PAGE_STATUS.UNPUBLISHING].includes(page.status)) return view(page, { noop: true });
  const antes = { status: page.status, siteSyncStatus: page.siteSyncStatus };
  const naFila = await IntegrationDispatch.findAll({ where: { companyId: ctx.companyId, aggregateType: AGGREGATE, aggregateId: page.id, operation: PUBLISH, status: ['PENDING', 'RETRY_WAIT'] }, transaction });
  const jaSaiu = await IntegrationDispatch.count({ where: { companyId: ctx.companyId, aggregateType: AGGREGATE, aggregateId: page.id, operation: PUBLISH, status: ['SENDING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED'] }, transaction });
  if (!jaSaiu) {
    for (const d of naFila) await transitionDispatch(ctx, d.id, 'CANCELLED', {}, { motivo: 'Página retirada antes de sair para o site.' }, transaction); // eslint-disable-line no-await-in-loop
    await page.update({ status: PAGE_STATUS.UNPUBLISHED, siteSyncStatus: SYNC.SYNCED, unpublishedAt: new Date(), lastError: null, dispatchConfirmed: false }, { transaction });
    await audit(ctx, page, 'integration.site_page.unpublish_requested', antes, { status: PAGE_STATUS.UNPUBLISHED }, 'Página que não chegou ao site: retirada sem chamar o site.', transaction);
    return view(page);
  }
  const numero = page.publishCount + 1;
  const { dispatch } = await createMinimizedDispatch(ctx, {
    connectionId: page.connectionId, operation: UNPUBLISH, idempotencyKey: `site:unpublish:${page.id}:${numero}`, criticalityOp: 'SAFE', domainObject: { pageKey: page.pageKey, slug: page.slug },
    aggregateType: AGGREGATE, aggregateId: page.id,
  }, transaction);
  await page.update({
    status: PAGE_STATUS.UNPUBLISHING, siteSyncStatus: SYNC.PENDING_SYNC, publishCount: numero, dispatchId: dispatch.id, dispatchOperation: UNPUBLISH, appliedRank: -1, appliedStatus: null, dispatchConfirmed: false,
    statusChecks: 0, statusCheckedAt: null, lastError: null, requestedBy: ctx.userId || null,
  }, { transaction });
  await audit(ctx, page, 'integration.site_page.unpublish_requested', antes, { status: PAGE_STATUS.UNPUBLISHING, dispatchId: dispatch.id }, 'Retirada da página pedida ao site: só vale quando o site confirmar.', transaction);
  return view(page);
}

module.exports = { unpublishSitePage };
