'use strict';

const { definePort } = require('../ports/definePort');

/** Port SignatureAdapter (domínio SIGNATURE, M9-D209): operações, entradas e saída normalizada versionadas. */
const SignatureAdapter = definePort('SignatureAdapter', 'SIGNATURE', {
  createEnvelope: ['documentRef', 'signers'],
  getEnvelope: ['externalResourceId'],
  cancelEnvelope: ['externalResourceId'],
  verifyWebhook: ['rawBody', 'headers'],
  downloadSigned: ['externalResourceId'],
});

module.exports = { SignatureAdapter };
