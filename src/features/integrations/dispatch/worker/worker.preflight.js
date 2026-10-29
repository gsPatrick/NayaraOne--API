'use strict';

const { getPreflights } = require('./worker.hooks');

/**
 * Verificações antes de gastar tentativa (M9-D214 3.2 item 2). Devolve { until, reason } para esperar ou null para chamar.
 *  - connection PAUSED, DISABLED, AUTH_FAILED (ou sem linha): espera `blocked_recheck_s`;
 *  - demais verificações registradas (cota, M9-D218).
 * O circuito (M9-D217) é consultado DEPOIS destas, em worker.process.js, porque admitir uma chamada de teste do HALF_OPEN ocupa uma vaga.
 */
async function runPreflight({ ctx, dispatch, connection, now, params, transaction }) {
  const recheck = new Date(now.getTime() + params.blockedRecheckS * 1000);
  if (!connection) return { until: recheck, reason: 'CONNECTION_MISSING' };
  if (connection.status !== 'ACTIVE') return { until: recheck, reason: `CONNECTION_${connection.status}` };
  for (const check of getPreflights()) {
    const verdict = await check({ ctx, dispatch, connection, now, params, transaction });
    if (verdict) return verdict;
  }
  return null;
}

module.exports = { runPreflight };
