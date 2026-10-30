'use strict';

/** Anúncios de imóvel nos portais (Marco 9, M9-D232 e M9-D233). Fachada da API pública. */
const { publishToPortals, listPortalListings } = require('./portal.publish');
const { syncListingStatuses, syncOne } = require('./portal.sync');
const { applyExternalListingStatus } = require('./portal.status');
const { installPortalEvents } = require('./portal.events');
const { fetchPortalPhoto } = require('./portal.photos');
const { PORTAL_SETTINGS_SCHEMA } = require('./portal.settings');
const { readPortalParams, PADROES } = require('./portal.params');
const constants = require('./portal.constants');

installPortalEvents();

module.exports = {
  ...constants, publishToPortals, listPortalListings, syncListingStatuses, syncOne, applyExternalListingStatus, installPortalEvents, fetchPortalPhoto, PORTAL_SETTINGS_SCHEMA, readPortalParams, PADROES,
};
