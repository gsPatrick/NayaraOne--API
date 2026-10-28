'use strict';

const router = require('./feature-flags.routes');
const service = require('./feature-flags.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = [];

module.exports = { router, service, events };
