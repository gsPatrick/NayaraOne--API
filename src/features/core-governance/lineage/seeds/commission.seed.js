'use strict';

// M9-D810 §3.3 — área COMMISSION (comissões e repasses): os indicadores de comissão e repasse da tabela de criticidade do BI.
const { buildForAreas } = require('../kit/paths');

module.exports = { code: 'M9-D810-commission', build: () => buildForAreas(['COMMISSION']) };
