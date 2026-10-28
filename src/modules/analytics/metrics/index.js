'use strict';

const registry = require('./registry.service');
const read = require('./registry.read');
const consistency = require('./registry.consistency');
const catalog = require('./formulaCatalog');

module.exports = { ...registry, ...read, ...consistency, createFormulaCatalog: catalog.createFormulaCatalog, getFormulaCatalog: catalog.getFormulaCatalog };
