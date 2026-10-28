'use strict';

const { sequelize, IntegrationConnection } = require('../../../models');
const { aggregateSamples } = require('./aggregateSamples');
const { collectSample } = require('./sampleSources');
const { loadHealthContext, statusOf } = require('./healthContext');
const { ensureCurrentRow, upsertWindow, writeCurrentMetrics } = require('./healthStore');

/** Janelas agregadas (minutos) e a janela deslizante que alimenta a linha atual. */
const WINDOWS = [5, 60, 1440];
const CURRENT_SLIDING_MIN = 5;
const MIN_MS = 60000;

const bucketStart = (now, minutes) => new Date(Math.floor(now.getTime() / (minutes * MIN_MS)) * minutes * MIN_MS);

/**
 * Agrega a saúde de uma connection (M9-D206): grava (UPSERT, nunca duplica) a janela corrente de 5 min, 60 min e
 * 1 dia e copia para a linha atual as métricas dos últimos 5 minutos, recalculando o estado de saúde.
 * Devolve a linha atual (snake_case).
 */
async function aggregateConnectionHealth(connection, { now = new Date() } = {}, transaction) {
  const healthCtx = await loadHealthContext(connection, transaction);
  for (const minutes of WINDOWS) {
    const from = bucketStart(now, minutes);
    const sample = await collectSample({ connection, from, to: now, windowMinutes: minutes }, transaction);
    await upsertWindow(connection, minutes, from, aggregateSamples(sample), sample.quota, now, transaction);
  }
  const sliding = await collectSample({ connection, from: new Date(now.getTime() - CURRENT_SLIDING_MIN * MIN_MS), to: now, windowMinutes: 0 }, transaction);
  const metrics = aggregateSamples(sliding);
  const current = await ensureCurrentRow(connection, now, transaction);
  const lastSampleAt = sliding.lastSampleAt ? new Date(sliding.lastSampleAt) : null;
  const projected = {
    ...current,
    success_rate: metrics.successRate,
    latency_p95_ms: metrics.latencyP95Ms,
    last_sample_at: [current.last_sample_at, lastSampleAt].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
  };
  return writeCurrentMetrics(connection.id, metrics, sliding.quota, lastSampleAt, statusOf(projected, healthCtx, now), now, transaction);
}

/**
 * Agrega todas as connections ACTIVE da empresa, cada uma num savepoint: a falha de uma (fonte quebrada, por
 * exemplo) não derruba as outras e não apaga a linha atual dela (M9-D206 seção 6).
 */
async function runCompanyAggregation(ctx, { now = new Date() } = {}, transaction) {
  const connections = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, status: 'ACTIVE' }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  const result = { processed: 0, failed: 0, errors: [] };
  for (const connection of connections) {
    try {
      await sequelize.transaction({ transaction }, (savepoint) => aggregateConnectionHealth(connection, { now }, savepoint));
      result.processed += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({ connectionId: connection.id, message: err.message });
    }
  }
  return result;
}

module.exports = { aggregateConnectionHealth, runCompanyAggregation, bucketStart };
