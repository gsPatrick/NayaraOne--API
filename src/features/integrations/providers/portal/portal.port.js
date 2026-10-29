'use strict';

const { definePort } = require('../ports/definePort');

/** Port PortalAdapter (domínio PORTAL, M9-D209): operações, entradas e saída normalizada versionadas. */
const PortalAdapter = definePort('PortalAdapter', 'PORTAL', {
  publishListing: ['listingRef'],
  updateListing: ['listingRef', 'externalResourceId'],
  unpublishListing: ['externalResourceId'],
  getListingStatus: ['externalResourceId'],
});

module.exports = { PortalAdapter };
