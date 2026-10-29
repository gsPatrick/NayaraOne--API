'use strict';

const { createFallbackSelector, TRIGGERS } = require('./fallbackSelector');
const { equivalenceProblems } = require('./equivalence');
const { readFallbackParams } = require('./fallback.params');
const settings = require('./fallback.settings');
const errors = require('./fallback.errors');

/** Fallback seguro de modelo e falha fechada (M9-D013). */
module.exports = { createFallbackSelector, TRIGGERS, equivalenceProblems, readFallbackParams, ...settings, errors };
