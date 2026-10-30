'use strict';

const { PortalSandboxBase } = require('./portal.sandbox.base');
const { fieldsFor, enumDe, TIPOS_BASE } = require('./portal.sandbox.fields');

/** Portal A (M9-D232, exemplo do livro): converte purpose=VENDA em SALE; aceita vídeo, tour virtual e destaque. */
const MAPPING = Object.freeze({
  fields: fieldsFor(),
  enums: {
    purpose: { VENDA: 'SALE', 'LOCAÇÃO': 'RENT' },
    type: enumDe(TIPOS_BASE, { RESIDENTIAL: 'RESIDENTIAL_PROPERTY', HOUSE: 'HOME', COMMERCIAL: 'COMMERCIAL_PROPERTY' }),
  },
});

class PortalZapSandboxAdapter extends PortalSandboxBase {
  providerCode() { return 'portal-zap-sandbox'; }

  idPrefix() { return 'zap'; }

  mapping() { return MAPPING; }

  mappingVersion() { return '1.2.0'; }

  portalCapabilities() { return ['video', 'virtualTour', 'highlight']; }
}

module.exports = { PortalZapSandboxAdapter };
