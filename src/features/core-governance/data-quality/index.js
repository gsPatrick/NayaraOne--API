'use strict';

const router = require('./data-quality.routes');
const service = require('./data-quality.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["data.quality.issue.opened"];

module.exports = { router, service, events };
