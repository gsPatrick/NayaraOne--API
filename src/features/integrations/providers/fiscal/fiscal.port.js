'use strict';

const { definePort } = require('../ports/definePort');

/** Port FiscalAdapter (domínio FISCAL, M9-D209): operações, entradas e saída normalizada versionadas. */
const FiscalAdapter = definePort('FiscalAdapter', 'FISCAL', {
  issueNfse: [],
  getNfseStatus: ['externalResourceId'],
  cancelNfse: ['externalResourceId'],
});

module.exports = { FiscalAdapter };
