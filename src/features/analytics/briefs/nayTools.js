'use strict';

// M9-D695 — API pública das ferramentas da NAY Diretoria no BI: catálogo fechado, guarda contra consulta livre e serviço de leitura.
const { NAY_TOOL_NAMES, BI_TOOL_PREFIX } = require('./nayTools.names');
const { NAY_TOOL_DEFINITIONS } = require('./nayTools.catalog');
const { assertNoFreeQuery, assertNayToolAllowed } = require('./nayTools.guard');
const { createNayAnalytics } = require('./nayTools.service');
const { NAY_TOOLS_SETTINGS_SCHEMA, NAY_TOOLS_DEFAULTS, readMaxItems } = require('../nayToolsSettings');

module.exports = {
  NAY_TOOL_NAMES, BI_TOOL_PREFIX, NAY_TOOL_DEFINITIONS, assertNoFreeQuery, assertNayToolAllowed, createNayAnalytics,
  NAY_TOOLS_SETTINGS_SCHEMA, NAY_TOOLS_DEFAULTS, readMaxItems,
};
