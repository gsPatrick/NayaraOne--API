'use strict';

const { definePort } = require('../ports/definePort');

/** Port BankAdapter (domínio BANK, M9-D209): operações, entradas e saída normalizada versionadas. */
const BankAdapter = definePort('BankAdapter', 'BANK', {
  submitPayment: ['amount', 'payee'],
  getPaymentStatus: ['externalResourceId'],
  getStatement: [],
  verifyWebhook: ['rawBody', 'headers'],
});

module.exports = { BankAdapter };
