'use strict';

/**
 * Estado de saúde de uma connection (M9-D206, regra 3.2.1). Ordem de decisão:
 *  1. DOWN: circuito OPEN (fato persistido, vale mesmo sem dado novo) ou `down_after_failures` health checks seguidos falhos;
 *  2. UNKNOWN: sem dado nas últimas `stale_after_s` (ou nunca houve);
 *  3. DEGRADED: circuito HALF_OPEN (em recuperação), taxa de sucesso abaixo da meta da criticidade ou p95 acima do SLO;
 *  4. HEALTHY.
 * `slo` = { minSuccessRate, p95Ms } da criticidade da connection (M9-D225).
 */
function computeHealthStatus(row, params, slo) {
  const now = (row.now instanceof Date ? row.now : new Date(row.now || Date.now())).getTime();
  if (row.circuitState === 'OPEN') return 'DOWN';
  if (Number(row.checkConsecutiveFailures || 0) >= params.downAfterFailures) return 'DOWN';
  const last = row.lastDataAt ? new Date(row.lastDataAt).getTime() : null;
  if (last === null || Number.isNaN(last) || now - last > params.staleAfterS * 1000) return 'UNKNOWN';
  if (row.circuitState === 'HALF_OPEN') return 'DEGRADED';
  if (row.successRate !== null && row.successRate !== undefined && Number(row.successRate) < slo.minSuccessRate) return 'DEGRADED';
  if (row.latencyP95Ms !== null && row.latencyP95Ms !== undefined && Number(row.latencyP95Ms) > slo.p95Ms) return 'DEGRADED';
  return 'HEALTHY';
}

module.exports = { computeHealthStatus };
