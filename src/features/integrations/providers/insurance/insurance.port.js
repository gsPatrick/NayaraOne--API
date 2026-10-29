'use strict';

const { definePort } = require('../ports/definePort');

/** Port InsuranceAdapter (domínio INSURANCE, M9-D209): operações, entradas e saída normalizada versionadas. */
const InsuranceAdapter = definePort('InsuranceAdapter', 'INSURANCE', {
  quote: [],
  propose: [],
  getPolicy: ['externalResourceId'],
  getStatus: ['externalResourceId'],
});

module.exports = { InsuranceAdapter };
