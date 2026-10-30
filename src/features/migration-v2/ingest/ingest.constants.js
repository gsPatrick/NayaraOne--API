'use strict';

/** Modos de carga da fonte (M9-D900 §3.1). */
const MODES = Object.freeze({ CDC: 'CDC', WATERMARK: 'WATERMARK', FULL_DIFF: 'FULL_DIFF' });

/** Lista única de estados de lote (decisão K8). */
const BATCH = Object.freeze({
  PLANNED: 'PLANNED', RUNNING: 'RUNNING', APPLIED: 'APPLIED', VERIFIED: 'VERIFIED', HASH_MISMATCH: 'HASH_MISMATCH', FAILED: 'FAILED', ABORTED: 'ABORTED',
});

/** Estados do registro de origem (M9-D901 §3.1; a Torre e as transições manuais são dela). */
const RECORD = Object.freeze({ PENDING: 'PENDING', MIGRATED: 'MIGRATED', RECONCILED: 'RECONCILED', QUARANTINED: 'QUARANTINED', PENDING_REVIEW: 'PENDING_REVIEW', EXCLUDED: 'EXCLUDED' });

const RUN = Object.freeze({ QUEUED: 'QUEUED', RUNNING: 'RUNNING', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED' });

/** Operações do evento do log de mudanças. */
const OPS = Object.freeze({ INSERT: 'I', UPDATE: 'U', DELETE: 'D' });

module.exports = { MODES, BATCH, RECORD, RUN, OPS };
