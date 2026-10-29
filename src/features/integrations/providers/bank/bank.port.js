'use strict';

const { definePort } = require('../ports/definePort');
const { bank } = require('../../minimization/mappers');

/** Port BankAdapter (domínio BANK, M9-D209): operações, entradas e saída normalizada versionadas. */
const BankAdapter = definePort('BankAdapter', 'BANK', {
  submitPayment: { required: ['amount', 'payee'], outputMapper: bank.submitPayment },
  getPaymentStatus: ['externalResourceId'],
  getStatement: [],
  verifyWebhook: ['rawBody', 'headers'],
});

module.exports = { BankAdapter };
