'use strict';

const router = require('./lineage.routes');
const service = require('./lineage.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = [];

module.exports = { router, service, events };
