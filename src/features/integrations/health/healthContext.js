'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { effectiveCriticality } = require('../providers/catalog.service');
const { readHealthParams } = require('./healthParams');
const { computeHealthStatus } = require('./healthStatus');

/** Connection da empresa da sessão (RLS) ou 404: connection de outra empresa é indistinguível de inexistente. */
async function loadConnection(connectionId, transaction) {
  const connection = await IntegrationConnection.findByPk(connectionId, { transaction });
  if (!connection) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  return connection;
}

/** Parâmetros e meta de SLO vigentes para a connection (criticidade da família, configurável por empresa). */
async function loadHealthContext(connection, transaction) {
  const ctx = { groupId: connection.groupId, companyId: connection.companyId };
  const [params, provider] = await Promise.all([
    readHealthParams(ctx, transaction),
    IntegrationProvider.findByPk(connection.providerCode, { transaction }),
  ]);
  const criticality = provider ? await effectiveCriticality(provider.domain, ctx, transaction) : 'MEDIUM';
  return { ctx, params, criticality, slo: params.slo[criticality] };
}

/** Estado de saúde a partir da linha atual (snake_case) e do contexto. */
function statusOf(row, healthCtx, now) {
  const lastCheck = row.last_check_at ? new Date(row.last_check_at).getTime() : 0;
  const lastSample = row.last_sample_at ? new Date(row.last_sample_at).getTime() : 0;
  const last = Math.max(lastCheck, lastSample);
  return computeHealthStatus({
    circuitState: row.circuit_state,
    successRate: row.success_rate === null || row.success_rate === undefined ? null : Number(row.success_rate),
    latencyP95Ms: row.latency_p95_ms,
    checkConsecutiveFailures: row.check_consecutive_failures,
    lastDataAt: last ? new Date(last) : null,
    now,
  }, healthCtx.params, healthCtx.slo);
}

module.exports = { loadConnection, loadHealthContext, statusOf };
