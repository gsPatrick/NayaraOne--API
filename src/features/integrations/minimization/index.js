'use strict';

/** Minimização de dados enviados a fornecedores (Marco 9, M9-D219). Fachada da API pública. */
const { defineMapper } = require('./defineMapper');
const { minimizePayload } = require('./minimize');
const { createMinimizedDispatch } = require('./minimized.dispatch');
const { resolveMaxClassification } = require('./minimization.params');
const classification = require('./classification');
const { BOOK_CEILING } = require('./purposeLimits');
const { MINIMIZATION_SETTINGS_SCHEMA } = require('./minimization.settings');

module.exports = { defineMapper, minimizePayload, createMinimizedDispatch, resolveMaxClassification, BOOK_CEILING, MINIMIZATION_SETTINGS_SCHEMA, ...classification };
