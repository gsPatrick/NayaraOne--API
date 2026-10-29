'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const { effectiveCriticality } = require('../providers/catalog.service');
const { hasContingencyHandler } = require('../providers/contingency.registry');
const { getCurrentHealth } = require('../health/healthQuery');
const { collectSample } = require('../health/sampleSources');
const { aggregateSamples } = require('../health/aggregateSamples');
const { metricsFromAggregate } = require('./admin.metrics');
const { maskSecretRef, daysUntil, brtDeep } = require('./admin.format');

const HOUR_MS = 3600000;

/** As métricas da última hora corrida (janela deslizante, como a linha atual da saúde), em 9 valores. */
async function lastHourMetrics(connection, now, transaction) {
  const sample = await collectSample({ connection, from: new Date(now.getTime() - HOUR_MS), to: now, windowMinutes: 60 }, transaction);
  return metricsFromAggregate(aggregateSamples(sample), sample.quota);
}

async function describeConnection(c, domainOf, ctx, now, transaction) {
  const domain = domainOf.get(c.providerCode) || null;
  const [health, criticality, metrics] = await Promise.all([
    getCurrentHealth(c.id, ctx, transaction, { now }),
    domain ? effectiveCriticality(domain, ctx, transaction) : null,
    lastHourMetrics(c, now, transaction),
  ]);
  const down = health.circuitState === 'OPEN' || health.healthStatus === 'DOWN';
  return {
    id: c.id,
    provider: c.providerCode,
    label: c.label,
    domain,
    environment: c.environment,
    status: c.status,
    criticality,
    circuitState: health.circuitState,
    healthStatus: health.healthStatus,
    metrics,
    secretRef: maskSecretRef(c.secretRef),
    secretExpiresInDays: daysUntil(c.secretExpiresAt, now),
    productionReleased: Boolean(c.productionReleasedAt),
    contingencyActive: Boolean(domain && down && hasContingencyHandler(domain)),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/**
 * GET /admin/integrations (M9-D249): uma linha por connection da empresa (a RLS isola as demais), com as métricas da última hora.
 * Nunca devolve a referência do cofre por inteiro nem a configuração da connection.
 */
async function listIntegrations(ctx, filters, transaction, { now = new Date() } = {}) {
  const where = { companyId: ctx.companyId };
  if (filters.environment) where.environment = filters.environment;
  if (filters.status) where.status = filters.status;
  const [connections, providers] = await Promise.all([
    IntegrationConnection.findAll({ where, order: [['provider_code', 'ASC'], ['environment', 'ASC'], ['label', 'ASC']], transaction }),
    IntegrationProvider.findAll({ attributes: ['code', 'domain'], transaction }),
  ]);
  const domainOf = new Map(providers.map((p) => [p.code, p.domain]));
  const itens = [];
  for (const c of connections) {
    if (filters.domain && domainOf.get(c.providerCode) !== filters.domain) continue;
    itens.push(await describeConnection(c, domainOf, ctx, now, transaction));
  }
  return brtDeep({ items: itens });
}

module.exports = { listIntegrations, lastHourMetrics };
