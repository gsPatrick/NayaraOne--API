'use strict';

/**
 * Publicação de páginas no site (Marco 9, M9-D259): a página do site ligada ao envio do Dispatch Service, com o estado interno só mudando por evento de confirmação, a falha do site sem desfazer o
 * estado interno e a ordem dos status valendo dentro do mesmo envio. Ao carregar, liga as reações aos eventos do envio, o tratador do webhook do site, a consulta de status na rodada do worker e os dados
 * da reconciliação. Fachada da API pública.
 */
const { registerDispatchCycleStep } = require('../dispatch/worker/worker.hooks');
const { registerReconcileEnricher } = require('../dispatch/reconcile/reconcile.enrichers');
const { publishSitePage } = require('./site.publish');
const { unpublishSitePage } = require('./site.unpublish');
const { applyExternalPageStatus } = require('./site.apply');
const { installSiteReactions } = require('./site.react');
const { installSiteEvents } = require('./site.events');
const { syncSitePages } = require('./site.sync');
const { siteReconcileEnricher } = require('./site.reconcile');
const { readSiteParams, PADROES } = require('./site.params');
const { SITE_SETTINGS_SCHEMA } = require('./site.settings');
const { pageKeyOf, pageFieldsOf } = require('./site.page');

let installed = false;
/** Liga o módulo uma vez por processo (carregar a fachada já liga; o servidor chama no boot). */
function installSite() {
  if (installed) return;
  installed = true;
  installSiteReactions();
  installSiteEvents();
  registerDispatchCycleStep((ctx, meta, transaction) => syncSitePages(ctx, meta, transaction));
  registerReconcileEnricher('SITE', siteReconcileEnricher);
}

installSite();

module.exports = { installSite, publishSitePage, unpublishSitePage, applyExternalPageStatus, syncSitePages, readSiteParams, SITE_PADROES: PADROES, SITE_SETTINGS_SCHEMA, pageKeyOf, pageFieldsOf };
