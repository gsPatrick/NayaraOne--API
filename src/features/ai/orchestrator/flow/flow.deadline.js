'use strict';

const E = require('./flow.errors');

/** Tempo que ainda resta ao run (`ia.agente.timeout_total_ms` desde a abertura). O relógio é injetável para provar o limite sem esperar. */
const remainingMs = (state) => state.deadline - state.clock();

/** Estourou o tempo total: 504 AI_RUN_TIMEOUT (o run termina FAILED). */
function checkDeadline(state) {
  if (remainingMs(state) <= 0) throw E.runTimeout();
}

module.exports = { remainingMs, checkDeadline };
