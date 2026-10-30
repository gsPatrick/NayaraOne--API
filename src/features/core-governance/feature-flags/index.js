'use strict';

const router = require('./feature-flags.routes');
const service = require('./feature-flags.service');
const { resolve } = require('./flags.resolve');

// Eventos do catálogo de governança que pertencem a este módulo (ver ../governance.events.js).
const events = [];

/** `flags.resolve(tenant, key, ref, transaction, opts)`: leitura única de valor, versão e origem do escopo (usada por M9-D872 e M9-D904). */
const flags = { resolve };

module.exports = { router, service, events, flags };
