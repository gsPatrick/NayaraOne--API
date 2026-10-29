'use strict';

/**
 * M9-D701 (3.7) — estados da exportação: QUEUED -> RUNNING -> READY -> EXPIRED e QUEUED|RUNNING -> FAILED. Qualquer outra mudança é
 * 409 ANALYTICS_EXPORT_INVALID_TRANSITION. A mesma regra vale para o worker, a limpeza e qualquer chamador do store.
 */
const AppError = require('../../utils/AppError');

const NEXT = Object.freeze({
  QUEUED: Object.freeze(['RUNNING', 'FAILED']),
  RUNNING: Object.freeze(['READY', 'FAILED']),
  READY: Object.freeze(['EXPIRED']),
  FAILED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
});

function assertExportTransition(from, to) {
  if (from === to) return;
  if (!(NEXT[from] || []).includes(to)) {
    throw AppError.conflict(`Transição de exportação inválida: ${from} -> ${to}.`, 'ANALYTICS_EXPORT_INVALID_TRANSITION', { from, to });
  }
}

module.exports = { assertExportTransition, EXPORT_TRANSITIONS: NEXT };
