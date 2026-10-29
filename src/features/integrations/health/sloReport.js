'use strict';

const { q, SELECT } = require('./healthStore');
const { evaluateSlo } = require('./slo');

/** Há quantos minutos espera o envio vencido mais antigo da connection (PENDING ou RETRY_WAIT já vencido); 0 com a fila em dia. */
async function readBacklogOldestMin(connectionId, now, transaction) {
  const rows = await q(
    `SELECT min(COALESCE(next_attempt_at, created_at)) AS oldest FROM "integration"."dispatches"
      WHERE connection_id = :id AND status IN ('PENDING', 'RETRY_WAIT') AND COALESCE(next_attempt_at, created_at) <= :now`,
    { id: connectionId, now }, transaction, SELECT,
  );
  const oldest = rows[0] && rows[0].oldest;
  return oldest ? Math.max(0, Math.floor((now.getTime() - new Date(oldest).getTime()) / 60000)) : 0;
}

/**
 * Relatório de SLO de uma connection (M9-D225): a meta da criticidade, o medido nas janelas do período e o julgamento por métrica.
 * `series`: pontos { callsTotal, callsSuccess, metrics } lidos de provider_health; `period`: { from, to }.
 */
async function buildSloReport({ connection, criticality, target, series, period, window, now }, transaction) {
  const backlogOldestMin = await readBacklogOldestMin(connection.id, now, transaction);
  const points = series.map((p) => ({ callsTotal: p.callsTotal, callsSuccess: p.callsSuccess, latencyP95Ms: p.metrics.latencyP95Ms, latencyP99Ms: p.metrics.latencyP99Ms }));
  return { criticality, window, periodStart: period.from, periodEnd: period.to, target, ...evaluateSlo({ target, points, backlogOldestMin }) };
}

module.exports = { buildSloReport, readBacklogOldestMin };
