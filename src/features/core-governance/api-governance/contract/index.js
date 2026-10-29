'use strict';

const fs = require('node:fs');
const { parseContract } = require('../openapi/openapi.load');
const { readData } = require('../standards/errorCatalog.data');

/** Contrato versionado já validado (o mesmo parser do lint da M9-D840). */
const loadContract = (file) => parseContract(fs.readFileSync(file, 'utf8'), 'contrato');
/** Códigos do catálogo de erros da M9-D843 (fonte de docs/ERROR_CODES.md). */
const catalogCodes = () => new Set(Object.keys(readData().codes));

module.exports = {
  loadContract, catalogCodes, ...require('./contract.errors'), ...require('./contract.guard'), ...require('./coverage.check'), ...require('./examples.load'), ...require('./examples.template'),
  ...require('./operations'), ...require('./report'), ...require('./response.check'), ...require('./runner'), ...require('./schema.validate'),
};
