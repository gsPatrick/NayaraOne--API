'use strict';

const { PortalSandboxBase } = require('./portal.sandbox.base');
const { fieldsFor, enumDe, TIPOS_BASE } = require('./portal.sandbox.fields');

/** Portal C (M9-D232): sem nenhuma capacidade extra, então o vídeo é omitido (e registrado em fields_dropped) sem falhar o anúncio. */
const MAPPING = Object.freeze({
  fields: fieldsFor(),
  enums: {
    purpose: { VENDA: 'sell', 'LOCAÇÃO': 'rent' },
    type: enumDe(TIPOS_BASE, { RESIDENTIAL: 'house', HOUSE: 'house', APARTMENT: 'apartment', COMMERCIAL: 'commercial', LAND: 'land', FARM: 'rural' }),
  },
});

class PortalOlxSandboxAdapter extends PortalSandboxBase {
  providerCode() { return 'portal-olx-sandbox'; }

  idPrefix() { return 'olx'; }

  mapping() { return MAPPING; }

  mappingVersion() { return '1.0.0'; }

  portalCapabilities() { return []; }
}

module.exports = { PortalOlxSandboxAdapter };
