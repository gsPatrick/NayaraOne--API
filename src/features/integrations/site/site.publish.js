'use strict';

const { SitePage, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveConnection } = require('../registry/connections.resolve');
const { createPropertyPublicationDispatch, loadPublicationReadModel } = require('../publication');
const { pageFieldsOf } = require('./site.page');
const { readSiteParams } = require('./site.params');
const { findPage, currentDispatch } = require('./site.store');
const { AGGREGATE, PUBLISH, PAGE_STATUS, SYNC, OPEN_DISPATCH } = require('./site.constants');

/** O imóvel e a connection ativa do site (404 INTEGRATION_CONNECTION_NOT_FOUND sem connection ativa; a contingência de canal é da M9-D430). */
async function siteConnection(ctx, connectionId, transaction) {
  if (connectionId) {
    const c = await IntegrationConnection.findOne({ where: { id: connectionId, companyId: ctx.companyId, status: 'ACTIVE' }, transaction });
    if (!c) throw AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
    return c;
  }
  return resolveConnection({ companyId: ctx.companyId, domain: 'SITE' }, transaction);
}

const audit = (ctx, page, action, antes, depois, reason, transaction) => registrarAuditoria({
  groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'SitePage', entityId: page.id, beforeJson: antes, afterJson: depois, reason,
}, transaction);

const view = (page, extra = {}) => ({
  pageId: page.id, pageKey: page.pageKey, status: page.status, siteSyncStatus: page.siteSyncStatus, dispatchId: page.dispatchId, contentHash: page.contentHash, noop: false, ...extra,
});

/**
 * publishSitePage — publica (ou atualiza) a página de um imóvel no site (M9-D259 3.2). O conteúdo vem SÓ do PublicPropertyReadModel (409 INTEGRATION_PROPERTY_NOT_PUBLISHABLE se o imóvel
 * não pode sair; nada é gravado). A página nasce PENDING com site_sync_status PENDING_SYNC e SÓ vira PUBLISHED quando o envio é confirmado (evento `integration.dispatch.confirmed`); página que já
 * está PUBLISHED segue assim enquanto a nova versão não chega ao site (a falha do site nunca desfaz o estado interno, INT-012). Repetir o pedido com o mesmo conteúdo não cria outro envio.
 * `args`: { propertyId, connectionId?, locale? }. Devolve { pageId, pageKey, status, siteSyncStatus, dispatchId, noop }.
 */
async function publishSitePage(ctx, args, transaction) {
  const connection = await siteConnection(ctx, args.connectionId, transaction);
  const readModel = await loadPublicationReadModel(ctx, args.propertyId, transaction);
  const locale = args.locale || (await readSiteParams(ctx, transaction)).defaultLocale;
  const campos = pageFieldsOf(readModel, locale);
  let page = await findPage(ctx, connection.id, campos.pageKey, transaction);
  if (!page) {
    page = await SitePage.create({
      groupId: ctx.groupId, companyId: ctx.companyId, connectionId: connection.id, pageKey: campos.pageKey, propertyId: args.propertyId, slug: campos.slug, locale, contentHash: campos.contentHash, requestedBy: ctx.userId || null,
    }, { transaction });
  }
  const aberto = await currentDispatch(ctx, page, transaction);
  const emAndamento = aberto && aberto.operation === PUBLISH && OPEN_DISPATCH.includes(aberto.status);
  const noAr = page.status === PAGE_STATUS.PUBLISHED && page.siteSyncStatus === SYNC.SYNCED && page.publishedHash === campos.contentHash;
  if (page.contentHash === campos.contentHash && (emAndamento || noAr)) return view(page, { noop: true });

  const antes = { status: page.status, siteSyncStatus: page.siteSyncStatus, contentHash: page.contentHash };
  const numero = page.publishCount + 1;
  const { dispatch } = await createPropertyPublicationDispatch(ctx, {
    connectionId: connection.id, propertyId: args.propertyId, operation: PUBLISH, locale, idempotencyKey: `site:publish:${page.id}:${campos.contentHash.slice(0, 24)}:${numero}`,
    aggregateType: AGGREGATE, aggregateId: page.id,
  }, transaction);
  const abertaAntes = aberto && OPEN_DISPATCH.includes(aberto.status) && aberto.id !== dispatch.id;
  await page.update({
    contentHash: campos.contentHash, slug: campos.slug, locale, propertyId: args.propertyId, publishCount: numero, dispatchId: dispatch.id, dispatchOperation: PUBLISH, appliedRank: -1, appliedStatus: null, dispatchConfirmed: false,
    statusChecks: 0, statusCheckedAt: null, siteSyncStatus: SYNC.PENDING_SYNC, lastError: null, requestedBy: ctx.userId || null,
    status: page.status === PAGE_STATUS.PUBLISHED ? PAGE_STATUS.PUBLISHED : PAGE_STATUS.PENDING,
  }, { transaction });
  await audit(ctx, page, 'integration.site_page.publish_requested', antes, { status: page.status, siteSyncStatus: SYNC.PENDING_SYNC, dispatchId: dispatch.id, replacedOpenDispatch: Boolean(abertaAntes) }, 'Publicação da página pedida ao site: só vale como publicada quando o site confirmar.', transaction);
  return view(page);
}

module.exports = { publishSitePage, siteConnection, audit, view };
