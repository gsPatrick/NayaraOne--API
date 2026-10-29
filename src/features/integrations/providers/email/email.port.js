'use strict';

const { definePort } = require('../ports/definePort');

/** Port EmailAdapter (domínio EMAIL, M9-D209): operações, entradas e saída normalizada versionadas. */
const EmailAdapter = definePort('EmailAdapter', 'EMAIL', {
  sendEmail: ['to', 'subject'],
  getDeliveryStatus: ['externalResourceId'],
  receiveInbound: ['payload'],
});

module.exports = { EmailAdapter };
