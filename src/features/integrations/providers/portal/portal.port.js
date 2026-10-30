'use strict';

const { definePort } = require('../ports/definePort');
const { portal } = require('../../minimization/mappers');
const { applyMapping } = require('./portal.mapping');

/** Port PortalAdapter (domínio PORTAL, M9-D209): operações, entradas e saída normalizada versionadas; mappers de saída da M9-D219. */
const PortalAdapter = definePort('PortalAdapter', 'PORTAL', {
  publishListing: { required: ['listingRef'], outputMapper: portal.publishListing },
  updateListing: { required: ['listingRef', 'externalResourceId'], outputMapper: portal.updateListing },
  unpublishListing: { required: ['externalResourceId'], outputMapper: portal.unpublishListing },
  getListingStatus: { required: ['externalResourceId'], outputMapper: portal.getListingStatus },
});

/**
 * Mapping, versão e capacidades do portal (M9-D232 3.2). O adapter declara `mapping()` (null = sem tradução: o pedido segue como está), `mappingVersion()` (semver)
 * e `portalCapabilities()` (video, virtualTour, highlight, batchPublish...). `mapListing(request)` aplica o mapping ao pedido minimizado e devolve
 * { payload, fieldsDropped, missing }; o serviço de anúncios usa o mesmo método para recusar internamente o que falta antes de chamar o portal.
 */
Object.assign(PortalAdapter.prototype, {
  mapping() { return null; },
  mappingVersion() { return '1.0.0'; },
  portalCapabilities() { return []; },
  mapListing(request) {
    const mapping = this.mapping();
    if (!mapping) return { payload: { ...request }, fieldsDropped: [], missing: [] };
    return applyMapping({ ...mapping, capabilities: this.portalCapabilities() }, request);
  },
});

module.exports = { PortalAdapter };
