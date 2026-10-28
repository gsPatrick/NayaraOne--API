'use strict';

const registry = require('./registry.service');
const read = require('./registry.read');
const consistency = require('./registry.consistency');
const catalog = require('./formulaCatalog');

// M9-D613: `camada` identifica a camada (contrato do teste de estrutura); M9-D603 acrescenta o registry. Nenhuma demanda pode substituir este export.
module.exports = { camada: 'metrics', ...registry, ...read, ...consistency, createFormulaCatalog: catalog.createFormulaCatalog, getFormulaCatalog: catalog.getFormulaCatalog };
