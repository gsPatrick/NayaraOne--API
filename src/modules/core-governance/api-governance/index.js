'use strict';

const router = require('./api-governance.routes');
const service = require('./api-governance.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["api.consumer.deprecation_due"];

module.exports = { router, service, events };
