'use strict';

/**
 * Criticidade por família configurada pelo administrador (Marco 9, M9-D201, parâmetro INT-P048):
 * `integration.catalog.criticality.<domínio em minúsculas>`. O padrão é o de catalog.domains
 * (DEFAULT_CRITICALITY). Dicionário fail-closed em SETTINGS_SCHEMA (settings.service faz o spread).
 */
const { DOMAINS } = require('./catalog.domains');

const CRITICALITY_VALUES = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const CRITICALITY_KEY_PREFIX = 'integration.catalog.criticality.';

const criticalityKey = (domain) => `${CRITICALITY_KEY_PREFIX}${String(domain).toLowerCase()}`;

const CATALOG_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(
  DOMAINS.map((domain) => [criticalityKey(domain), { type: 'string', enum: [...CRITICALITY_VALUES] }])
));

module.exports = { CATALOG_SETTINGS_SCHEMA, CRITICALITY_VALUES, criticalityKey };
