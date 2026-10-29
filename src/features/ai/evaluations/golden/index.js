'use strict';

const service = require('./goldenCases.service');
const source = require('./goldenSource');
const coverage = require('./goldenCoverage');
const { applyGoldenChecks } = require('./goldenChecks');
const { piiTypesIn } = require('./golden.validation');
const constants = require('./golden.constants');

/** Golden datasets por agente (M9-D033): cadastro versionado, fonte de casos da avaliação e cobertura mínima por categoria. */
module.exports = { ...service, ...source, ...coverage, applyGoldenChecks, piiTypesIn, constants };
