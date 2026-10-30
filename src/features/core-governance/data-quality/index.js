'use strict';

const { Router } = require('express');
const dataQualityRouter = require('./data-quality.routes');
const retentionRouter = require('./retention.routes');
const service = require('./data-quality.service');
const { installQualityHooks } = require('./quality.hooks');

// M9-D806: a avaliação de qualidade "na gravação do cadastro" depende dos hooks dos modelos.
installQualityHooks();

// Rotas do módulo: /data-quality e, da retenção (M9-D911), /retention.
const router = Router().use(dataQualityRouter, retentionRouter);

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["data.quality.issue.opened"];

module.exports = { router, service, events };
