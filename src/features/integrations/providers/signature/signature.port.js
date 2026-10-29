'use strict';

const { definePort } = require('../ports/definePort');
const { signature } = require('../../minimization/mappers');

/** Port SignatureAdapter (domínio SIGNATURE, M9-D209): operações, entradas e saída normalizada versionadas. */
const SignatureAdapter = definePort('SignatureAdapter', 'SIGNATURE', {
  createEnvelope: { required: ['documentRef', 'signers'], outputMapper: signature.createEnvelope },
  getEnvelope: ['externalResourceId'],
  cancelEnvelope: ['externalResourceId'],
  verifyWebhook: ['rawBody', 'headers'],
  downloadSigned: ['externalResourceId'],
});

module.exports = { SignatureAdapter };
