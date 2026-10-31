'use strict';

const { govError } = require('../../core-governance/governance.errors');

/** Erros da integridade do lote (M9-D905 §4). */
module.exports = {
  schemaMissing: (entity) => govError(422, 'GOV_MIG_SCHEMA_MISSING', 'Defina o esquema canônico da entidade.', { entity }),
  HASH_MISMATCH_MESSAGE: 'O conteúdo do lote no destino difere da origem.',
  BATCH_UNVERIFIED_MESSAGE: 'Há lotes sem verificação de integridade.',
};
