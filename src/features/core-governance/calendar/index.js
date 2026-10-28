'use strict';

const router = require('./calendar.routes');
const service = require('./calendar.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["calendar.item.updated"];

module.exports = { router, service, events };
