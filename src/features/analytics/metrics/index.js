'use strict';

const registry = require('./registry.service');
const read = require('./registry.read');
const consistency = require('./registry.consistency');
const catalog = require('./formulaCatalog');
const version = require('./registry.version');
const update = require('./registry.update');
const asOf = require('./registry.asOf');
const { recalculate } = require('./reproduction');
const { calcHash } = require('./calcHash');
const natures = require('./registry.natures');
const { buildSeriesByNature } = require('./series.byNature');

// M9-D613: `camada` identifica a camada (contrato do teste de estrutura); M9-D603 acrescenta o registry. Nenhuma demanda pode substituir este export.
module.exports = { camada: 'metrics', ...registry, ...read, ...consistency, publishVersion: version.publishVersion, updateDefinition: update.updateDefinition, readMetricAsOf: asOf.readMetricAsOf, recalculateHistorical: asOf.recalculateHistorical, recalculate, calcHash, buildSeriesByNature, VALUE_NATURES: natures.VALUE_NATURES, NATURE_LABELS: natures.NATURE_LABELS, createFormulaCatalog: catalog.createFormulaCatalog, getFormulaCatalog: catalog.getFormulaCatalog };
