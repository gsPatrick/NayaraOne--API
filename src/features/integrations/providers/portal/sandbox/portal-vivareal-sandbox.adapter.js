'use strict';

const { PortalSandboxBase } = require('./portal.sandbox.base');
const { fieldsFor, enumDe, TIPOS_BASE } = require('./portal.sandbox.fields');

/** Portal B (M9-D232, exemplo do livro): exige `bathrooms`; sem esse campo o anúncio fica REJECTED internamente, sem chamar o portal. Aceita vídeo e publicação em lote. */
const MAPPING = Object.freeze({
  fields: fieldsFor({ obrigatorios: ['bathrooms'] }),
  enums: {
    purpose: { VENDA: 'FOR_SALE', 'LOCAÇÃO': 'FOR_RENT' },
    type: enumDe(TIPOS_BASE, { RESIDENTIAL: 'RESIDENTIAL', HOUSE: 'HOUSE', APARTMENT: 'FLAT' }),
  },
});

class PortalVivaRealSandboxAdapter extends PortalSandboxBase {
  providerCode() { return 'portal-vivareal-sandbox'; }

  idPrefix() { return 'viva'; }

  mapping() { return MAPPING; }

  mappingVersion() { return '2.0.0'; }

  portalCapabilities() { return ['video', 'batchPublish']; }
}

module.exports = { PortalVivaRealSandboxAdapter };
