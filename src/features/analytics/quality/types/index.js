'use strict';

// M9-D696 — fábricas dos seis tipos de check do livro (§18 e Guia §8). Cada read model monta o seu catálogo com elas.
const { completeness } = require('./completeness');
const { duplication } = require('./duplication');
const { freshness } = require('./freshness');
const { rowCountRange, plausibleValues } = require('./rowCountRange');
const { reconciliation } = require('./reconciliation');
const { invariant, consistency } = require('./invariant');

module.exports = { completeness, duplication, freshness, rowCountRange, plausibleValues, reconciliation, invariant, consistency };
