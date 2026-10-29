'use strict';

const { IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getServerEnvironment } = require('../registry/registry.helpers');
const { getCurrentHealth } = require('../health/healthQuery');
const { loadHealthContext } = require('../health/healthContext');
const { q, SELECT } = require('../health/healthStore');
const { metricsFromRow } = require('./admin.metrics');
const { brtDeep } = require('./admin.format');

const DAY_MIN = 1440;
/** Para cada janela: o tamanho de cada ponto da série (minutos) e quanto tempo a série mostra (minutos). */
const WINDOWS = Object.freeze({
  '5m': { bucketMin: 5, rangeMin: 60 },
  '1h': { bucketMin: 60, rangeMin: DAY_MIN },
  '1d': { bucketMin: DAY_MIN, rangeMin: 7 * DAY_MIN },
  '30d': { bucketMin: DAY_MIN, rangeMin: 30 * DAY_MIN },
});
const runbookPathOf = (providerCode) => `docs/runbooks/integrations/${providerCode}.md`;

/** A connection do fornecedor na empresa: a do ambiente pedido; sem pedido, a ativa, depois a do ambiente do servidor, depois a mais recente. */
async function findConnection(providerCode, environment, ctx, transaction) {
  const where = { companyId: ctx.companyId, providerCode };
  if (environment) where.environment = environment;
  const todas = await IntegrationConnection.findAll({ where, transaction });
  if (todas.length === 0) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  const servidor = getServerEnvironment();
  const peso = (c) => (c.status === 'ACTIVE' ? 0 : 2) + (c.environment === servidor ? 0 : 1);
  return todas.sort((a, b) => peso(a) - peso(b) || new Date(b.updated_at) - new Date(a.updated_at))[0];
}

async function readSeries(connection, window, now, transaction) {
  const { bucketMin, rangeMin } = WINDOWS[window];
  const rows = await q(
    'SELECT * FROM "integration"."provider_health" WHERE connection_id = :id AND window_minutes = :m AND window_start >= :from ORDER BY window_start ASC',
    { id: connection.id, m: bucketMin, from: new Date(now.getTime() - rangeMin * 60000) }, transaction, SELECT,
  );
  return rows.map((r) => ({
    windowStart: r.window_start, windowMinutes: r.window_minutes, callsTotal: r.calls_total, callsSuccess: r.calls_success, callsFailed: r.calls_failed, metrics: metricsFromRow(r),
  }));
}

/** O sucesso medido no período contra a meta da criticidade (a soma das janelas; sem chamadas não há taxa). */
function sloSummary(target, criticality, series) {
  const total = series.reduce((s, p) => s + p.callsTotal, 0);
  const ok = series.reduce((s, p) => s + p.callsSuccess, 0);
  const rate = total === 0 ? null : Math.round((ok / total) * 10000) / 100;
  return {
    criticality,
    target,
    measured: { callsTotal: total, callsSuccess: ok, callsFailed: total - ok, successRate: rate },
    violated: total === 0 ? null : (ok / total) * 100 < target.minSuccessRate,
  };
}

/**
 * GET /admin/integrations/:provider/health (M9-D249): saúde detalhada de um fornecedor da empresa. Fornecedor que a empresa não
 * tem (ou que é de outra empresa) é 404 INTEGRATION_CONNECTION_NOT_FOUND.
 */
async function getProviderHealth(providerCode, query, ctx, transaction, { now = new Date() } = {}) {
  const connection = await findConnection(providerCode, query.environment, ctx, transaction);
  const [current, healthCtx, series] = await Promise.all([
    getCurrentHealth(connection.id, ctx, transaction, { now }),
    loadHealthContext(connection, transaction),
    readSeries(connection, query.window, now, transaction),
  ]);
  return brtDeep({
    provider: connection.providerCode,
    connectionId: connection.id,
    environment: connection.environment,
    status: connection.status,
    window: query.window,
    healthStatus: current.healthStatus,
    series,
    lastCheck: { at: current.lastCheckAt || null, ok: current.lastCheckOk ?? null, latencyMs: current.lastCheckLatencyMs ?? null },
    circuit: {
      state: current.circuitState, openedAt: current.circuitOpenedAt || null, cooldownS: current.circuitCooldownS ?? null,
      consecutiveFailures: current.consecutiveFailures ?? 0, halfOpenSuccesses: current.halfOpenSuccesses ?? 0,
    },
    quota: { limit: current.quotaLimit ?? null, remaining: current.quotaRemaining ?? null, resetsAt: current.quotaResetsAt || null },
    slo: sloSummary(healthCtx.slo, healthCtx.criticality, series),
    runbookPath: runbookPathOf(connection.providerCode),
  });
}

module.exports = { getProviderHealth, runbookPathOf, WINDOWS };
