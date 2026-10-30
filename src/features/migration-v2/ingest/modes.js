'use strict';

const { MODES } = require('./ingest.constants');
const errors = require('./ingest.errors');

/** A fonte precisa declarar CDC, WATERMARK ou FULL_DIFF; qualquer outro valor é 422 GOV_MIG_SOURCE_MODE_INVALID. */
function assertMode(mode) {
  if (!Object.values(MODES).includes(mode)) throw errors.sourceModeInvalid();
  return mode;
}

module.exports = { assertMode };
