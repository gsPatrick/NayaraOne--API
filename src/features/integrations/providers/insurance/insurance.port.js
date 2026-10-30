'use strict';

const { definePort } = require('../ports/definePort');
const { insurance } = require('../../minimization/mappers');

/** Port InsuranceAdapter (domínio INSURANCE, M9-D209): operações, entradas e saída normalizada versionadas. */
const InsuranceAdapter = definePort('InsuranceAdapter', 'INSURANCE', {
  quote: { required: [], outputMapper: insurance.quote },
  propose: { required: [], outputMapper: insurance.propose },
  getPolicy: ['externalResourceId'],
  getStatus: ['externalResourceId'],
  submitClaim: { required: [], outputMapper: insurance.submitClaim },
  verifyWebhook: ['rawBody', 'headers'],
});

module.exports = { InsuranceAdapter };
