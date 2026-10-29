'use strict';

const { definePort } = require('../ports/definePort');

/** Port FinancingProviderAdapter (domínio FINANCING, M9-D209): operações, entradas e saída normalizada versionadas. */
const FinancingProviderAdapter = definePort('FinancingProviderAdapter', 'FINANCING', {
  simulate: [],
  submitCase: [],
  getCaseStatus: ['externalResourceId'],
  uploadDocument: [],
  requestAppraisal: [],
  verifyWebhook: ['rawBody', 'headers'],
  cancelCase: ['externalResourceId'],
});

module.exports = { FinancingProviderAdapter };
