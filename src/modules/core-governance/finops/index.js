'use strict';

const router = require('./finops.routes');
const service = require('./finops.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["finops.budget.threshold"];

module.exports = { router, service, events };
