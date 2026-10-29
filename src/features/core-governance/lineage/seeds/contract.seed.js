'use strict';

// M9-D810 §3.3 — área CONTRACT (contratos e versões): os indicadores de contrato da tabela de criticidade do BI.
const { buildForAreas } = require('../kit/paths');

module.exports = { code: 'M9-D810-contract', build: () => buildForAreas(['CONTRACT']) };
