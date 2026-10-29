'use strict';

const { definePort } = require('../ports/definePort');
const { email } = require('../../minimization/mappers');

/** Port EmailAdapter (domínio EMAIL, M9-D209): operações, entradas e saída normalizada versionadas. */
const EmailAdapter = definePort('EmailAdapter', 'EMAIL', {
  sendEmail: { required: ['to', 'subject'], outputMapper: email.sendEmail },
  getDeliveryStatus: ['externalResourceId'],
  receiveInbound: ['payload'],
});

module.exports = { EmailAdapter };
