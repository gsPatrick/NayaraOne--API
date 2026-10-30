'use strict';

const { BATCH } = require('./ingest.constants');
const errors = require('./ingest.errors');

/**
 * Máquina de estados do lote (M9-D900 §3.4, decisão K8). VERIFIED e ABORTED são finais. APPLIED -> VERIFIED | HASH_MISMATCH é a verificação da M9-D905.
 */
const TRANSITIONS = Object.freeze({
  [BATCH.PLANNED]: [BATCH.RUNNING],
  [BATCH.RUNNING]: [BATCH.APPLIED, BATCH.FAILED, BATCH.ABORTED],
  [BATCH.FAILED]: [BATCH.RUNNING],
  [BATCH.APPLIED]: [BATCH.VERIFIED, BATCH.HASH_MISMATCH],
  [BATCH.HASH_MISMATCH]: [BATCH.RUNNING],
  [BATCH.VERIFIED]: [],
  [BATCH.ABORTED]: [],
});

const FINAL = Object.freeze([BATCH.VERIFIED, BATCH.ABORTED]);
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw errors.invalidTransition(from, to);
}

module.exports = { TRANSITIONS, FINAL, canTransition, assertTransition };
