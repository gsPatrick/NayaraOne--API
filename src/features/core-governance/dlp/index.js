'use strict';

const router = require('./dlp.routes');
const service = require('./dlp.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["dlp.export.blocked"];

module.exports = { router, service, events };
