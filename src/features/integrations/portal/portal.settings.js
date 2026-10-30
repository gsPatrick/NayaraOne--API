'use strict';

/** Parâmetros dos portais (M9-D232): dicionário de SETTINGS_SCHEMA; a leitura está em portal.params.js. */
const PORTAL_SETTINGS_SCHEMA = Object.freeze({
  // INT-P077: de quantos em quantos minutos o status dos anúncios é lido no portal (fluxo portal.listing_status).
  'integration.portal.reconcile_interval_min': { type: 'integer', min: 1, max: 1440 },
  // Anúncios lidos por página a cada rodada do sync (cursor retomável).
  'integration.portal.sync_page_size': { type: 'integer', min: 5, max: 500 },
});

module.exports = { PORTAL_SETTINGS_SCHEMA };
