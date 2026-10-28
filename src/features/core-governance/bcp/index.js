'use strict';

const router = require('./bcp.routes');
const service = require('./bcp.service');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["bcp.manual_operation.recorded","bcp.manual_operation.imported"];

module.exports = { router, service, events };
