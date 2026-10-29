'use strict';

const { definePort } = require('../ports/definePort');
const { portal } = require('../../minimization/mappers');

/** Port PortalAdapter (domínio PORTAL, M9-D209): operações, entradas e saída normalizada versionadas; mappers de saída da M9-D219. */
const PortalAdapter = definePort('PortalAdapter', 'PORTAL', {
  publishListing: { required: ['listingRef'], outputMapper: portal.publishListing },
  updateListing: { required: ['listingRef', 'externalResourceId'], outputMapper: portal.updateListing },
  unpublishListing: { required: ['externalResourceId'], outputMapper: portal.unpublishListing },
  getListingStatus: { required: ['externalResourceId'], outputMapper: portal.getListingStatus },
});

module.exports = { PortalAdapter };
