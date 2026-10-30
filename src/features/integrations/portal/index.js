'use strict';

/** Anúncios de imóvel nos portais (Marco 9, M9-D232 e M9-D233). Fachada da API pública. */
const { publishToPortals, listPortalListings } = require('./portal.publish');
const { syncListingStatuses, syncOne } = require('./portal.sync');
const { unpublishFromPortals } = require('./portal.unpublish');
const { reconcileUnpublishing } = require('./portal.unpublish.reconcile');
const { applyExternalListingStatus } = require('./portal.status');
const { installPortalEvents } = require('./portal.events');
const { fetchPortalPhoto } = require('./portal.photos');
const { PORTAL_SETTINGS_SCHEMA } = require('./portal.settings');
const { readPortalParams, PADROES } = require('./portal.params');
const { portalStep, handleAgedPortal } = require('./portal.contingency');
const { reprocessPendingSync } = require('./portal.reprocess');
const constants = require('./portal.constants');

installPortalEvents();

/** Liga o portal ao framework de contingência (M9-D227): PENDING_SYNC, tarefa ao marketing e item vencido do anúncio. */
function installPortalContingency() {
  const contingency = require('../contingency/contingency.domainHooks');
  contingency.registerContingencyStep('PORTAL', portalStep);
  contingency.registerAgedHandler('PORTAL', handleAgedPortal);
}
installPortalContingency();

module.exports = {
  ...constants, publishToPortals, listPortalListings, syncListingStatuses, syncOne, unpublishFromPortals, reconcileUnpublishing, applyExternalListingStatus, installPortalEvents, fetchPortalPhoto, reprocessPendingSync, installPortalContingency, PORTAL_SETTINGS_SCHEMA, readPortalParams, PADROES,
};
