'use strict';

// Apoio dos testes dos KPIs de Comercial e Imóveis do BI (M9-D632, M9-D633): duas empresas NOVAS no grupo do seed (biEnv), relógio fixo em 28/10/2026
// 12:00 de São Paulo, cálculo/leitura dos KPIs e o servidor HTTP real de /analytics com a empresa X como "A" e a Y como "B". Banco descartável.
const http = require('node:http');
const express = require('express');
const bi = require('./biEnv');
const clock = require('../../../src/features/analytics/metrics/clock');
const registry = require('../../../src/features/analytics/metrics');
const { materializeCommercialKpis } = require('../../../src/features/analytics/metrics/kpis/commercial');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

const { NOW, TODAY } = bi;

async function startHttp(env) {
  const tenants = { A: env.cX, B: env.cY };
  const fakeAuth = (req, res, next) => {
    req.auth = { ...tenants[req.get('x-test-tenant') || 'A'], roles: [], permissions: (req.get('x-test-perms') || '').split(',').filter(Boolean) };
    next();
  };
  const { createAnalyticsRouter } = require('../../../src/features/analytics');
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/v1', createAnalyticsRouter({ authChain: [fakeAuth, tenantMiddleware] }));
  app.use(errorHandler);
  env.server = http.createServer(app);
  await new Promise((resolve) => env.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${env.server.address().port}/v1`;
  env.call = async (url, { perms = ['analytics:read'], tenant = 'A' } = {}) => {
    const res = await fetch(`${base}${url}`, { headers: { 'x-test-tenant': tenant, 'x-test-perms': perms.join(',') } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function setup({ withHttp = false } = {}) {
  const env = await bi.setup();
  clock.setClock(() => NOW);
  if (withHttp) await startHttp(env);
  return env;
}

async function teardown(env) {
  clock.resetClock();
  if (env.server) await new Promise((resolve) => env.server.close(resolve));
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM crm.property_radars WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.data_quality_checks WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
  });
  await bi.teardown(env);
}

/** Calcula e grava os snapshots dos KPIs da empresa na data-base (padrão: hoje fixo). */
const kpis = (t, { asOf = TODAY, only = null } = {}) => bi.inTx(t, { commit: true }, (tx) => materializeCommercialKpis({ companyId: t.companyId, groupId: t.groupId }, asOf, tx, { only }));

const ctxOf = (t, permissions = ['analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });

/** Lê o KPI como a API lê: pelo snapshot gravado da data-base (dimensão opcional). */
const readKpi = (t, metricCode, { asOfDate = TODAY, dimensionKey = '' } = {}) => bi.inTx(t, {}, (tx) => registry.readMetricAsOf(ctxOf(t),
  { metricCode, scopeType: 'COMPANY', scopeId: t.companyId, asOfDate, dimensionKey }, tx));

const readModels = require('../../../src/features/analytics/read-models');
const MODELS = ['rm_crm_visits_proposals', 'rm_property_portfolio', 'rm_property_price_changes', 'rm_radar_matches', 'rm_broker_performance'];

/** Reconstrói da fonte os read models de Comercial e Imóveis da empresa (o mesmo cálculo do worker, para todas as chaves). */
async function refreshModels(t, models = MODELS) {
  const ctx = { groupId: t.groupId, actorUserId: t.userId, permissions: ['analytics:rebuild'], reason: 'Teste: read model reconstruído da fonte.' };
  for (const model of models) {
    try {
      const r = await readModels.rebuildReadModel(ctx, { model, companyId: t.companyId });
      if (r.status !== 'SUCCEEDED') throw new Error(`rebuild de ${model}: ${r.status}`);
    } catch (err) {
      if (err.details && err.details.checks) err.message += ` ${model}: ${JSON.stringify(err.details.checks.filter((c) => c.status !== 'PASSED'))}`;
      throw err;
    }
  }
}

module.exports = { ...bi, setup, teardown, kpis, readKpi, refreshModels, ctxOf, NOW, TODAY, MODELS };
