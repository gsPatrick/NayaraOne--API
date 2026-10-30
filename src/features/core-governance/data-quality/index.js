'use strict';

const { Router } = require('express');
const dataQualityRouter = require('./data-quality.routes');
const retentionRouter = require('./retention.routes');
const classificationRouter = require('./classification.routes');
const classificationWiring = require('./classification.wiring');
const service = require('./data-quality.service');
const { installQualityHooks } = require('./quality.hooks');

// M9-D806: a avaliação de qualidade "na gravação do cadastro" depende dos hooks dos modelos.
installQualityHooks();

// M9-D910: o registro de classificação passa a ser a fonte do resolvedor de DLP e da máscara usada na anonimização da retenção.
classificationWiring.install();

// Rotas do módulo: /data-quality, a retenção (M9-D911, /retention) e o registro de classificação (M9-D910, /data-classification).
const router = Router().use(dataQualityRouter, retentionRouter, classificationRouter);

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = ["data.quality.issue.opened"];

module.exports = { router, service, events };
