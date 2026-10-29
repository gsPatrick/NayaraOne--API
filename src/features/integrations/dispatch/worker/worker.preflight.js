'use strict';

const { readCircuitState } = require('../../health/circuitState');
const { getPreflights } = require('./worker.hooks');

/**
 * Verificações antes de gastar tentativa (M9-D214 3.2 item 2). Devolve { until, reason } para esperar ou null para chamar.
 *  - connection PAUSED, DISABLED, AUTH_FAILED (ou sem linha): espera `blocked_recheck_s`;
 *  - circuito OPEN e operação não essencial: espera até o fim do cooldown (circuit_opened_at + circuit_cooldown_s);
 *  - demais verificações registradas (cota, M9-D218).
 */
async function runPreflight({ ctx, dispatch, connection, now, params, transaction }) {
  const recheck = new Date(now.getTime() + params.blockedRecheckS * 1000);
  if (!connection) return { until: recheck, reason: 'CONNECTION_MISSING' };
  if (connection.status !== 'ACTIVE') return { until: recheck, reason: `CONNECTION_${connection.status}` };
  if (!dispatch.essential) {
    const circuito = await readCircuitState(connection.id, ctx, transaction, { now, fresh: true });
    if (circuito.circuitState === 'OPEN') {
      const abertoEm = circuito.circuitOpenedAt ? new Date(circuito.circuitOpenedAt).getTime() : null;
      const fim = abertoEm !== null && Number.isFinite(circuito.circuitCooldownS) ? abertoEm + circuito.circuitCooldownS * 1000 : null;
      if (fim === null) return { until: recheck, reason: 'CIRCUIT_OPEN' };
      if (fim > now.getTime()) return { until: new Date(fim), reason: 'CIRCUIT_OPEN' };
    }
  }
  for (const check of getPreflights()) {
    const verdict = await check({ ctx, dispatch, connection, now, params, transaction });
    if (verdict) return verdict;
  }
  return null;
}

module.exports = { runPreflight };
