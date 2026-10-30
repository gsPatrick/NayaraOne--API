'use strict';

const { definePort } = require('../ports/definePort');
const { fiscal } = require('../../minimization/mappers');

/** Port FiscalAdapter (domínio FISCAL, M9-D209): operações, entradas e saída normalizada versionadas. */
const FiscalAdapter = definePort('FiscalAdapter', 'FISCAL', {
  issueNfse: { required: [], outputMapper: fiscal.issueNfse },
  getNfseStatus: { required: ['externalResourceId'], outputMapper: fiscal.getNfseStatus },
  cancelNfse: { required: ['externalResourceId'], outputMapper: fiscal.cancelNfse },
});

module.exports = { FiscalAdapter };
