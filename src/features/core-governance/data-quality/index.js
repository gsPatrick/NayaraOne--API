'use strict';

const router = require('./data-quality.routes');
const service = require('./data-quality.service');
const { installQualityHooks } = require('./quality.hooks');

// M9-D806: a avaliação de qualidade "na gravação do cadastro" depende dos hooks dos modelos.
installQualityHooks();

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["data.quality.issue.opened"];

module.exports = { router, service, events };
