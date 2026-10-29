'use strict';

// M9-D810 §3.3 — área MONEY (lançamentos financeiros e parcelas): os indicadores de dinheiro da tabela de criticidade do BI.
const { buildForAreas } = require('../kit/paths');

module.exports = { code: 'M9-D810-money', build: () => buildForAreas(['MONEY']) };
