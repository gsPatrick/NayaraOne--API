'use strict';

const router = require('./calendar.routes');
const service = require('./calendar.service');

require('./projector/projector.consumer').install(); // M9-D802: o calendário passa a consumir os eventos das origens

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["calendar.item.updated"];

module.exports = { router, service, events };
