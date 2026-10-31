'use strict';

const { RECORD } = require('../ingest/ingest.constants');

/**
 * Transições permitidas do registro de origem (M9-D901 §3.1). Proibido: RECONCILED -> PENDING e PENDING -> RECONCILED. EXCLUDED é final. A volta de RECONCILED a MIGRATED
 * (mudança pela origem) é do aplicador de delta da M9-D900, não uma transição manual, e por isso não consta aqui.
 */
const TRANSITIONS = Object.freeze({
  [RECORD.PENDING]: [RECORD.MIGRATED, RECORD.QUARANTINED, RECORD.PENDING_REVIEW],
  [RECORD.QUARANTINED]: [RECORD.PENDING, RECORD.PENDING_REVIEW, RECORD.EXCLUDED],
  [RECORD.PENDING_REVIEW]: [RECORD.MIGRATED, RECORD.QUARANTINED, RECORD.EXCLUDED],
  [RECORD.MIGRATED]: [RECORD.RECONCILED, RECORD.QUARANTINED],
  [RECORD.RECONCILED]: [],
  [RECORD.EXCLUDED]: [],
});

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/** Decisão humana por estado de origem (§3.1.1 item 2): decisão -> estado de destino. */
const DECISIONS = Object.freeze({
  [RECORD.QUARANTINED]: Object.freeze({ REPROCESS: RECORD.PENDING, SEND_TO_REVIEW: RECORD.PENDING_REVIEW, EXCLUDE: RECORD.EXCLUDED }),
  [RECORD.PENDING_REVIEW]: Object.freeze({ APPROVE: RECORD.MIGRATED, QUARANTINE: RECORD.QUARANTINED, EXCLUDE: RECORD.EXCLUDED }),
});

module.exports = { TRANSITIONS, DECISIONS, canTransition };
