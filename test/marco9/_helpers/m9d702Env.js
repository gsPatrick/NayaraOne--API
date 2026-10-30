'use strict';

// Apoio dos testes da M9-D702 (API /analytics de métricas e painéis): servidor Express com o router real, autenticação simulada por cabeçalho
// (empresa e permissões) sobre as duas empresas da base descartável, e gravação de snapshots em datas e dimensões escolhidas. Roda SÓ em banco
// descartável (127.0.0.1). A limpeza dos dados fica a cargo do `teardown` do ambiente que criou as métricas.
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const store = require('../../../src/features/analytics/metricStore.service');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

/** Sobe o router real de /analytics; `call(método, url, { perms, tenant })` devolve { status, body }. `extraTenants`: empresas de teste além de A e B (chave = nome do cabeçalho). */
async function startServer(env, extraTenants = {}) {
  const tenants = { A: env.tenantA, B: env.tenantB, ...extraTenants };
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
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, url, { perms = [], tenant = 'A' } = {}) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'x-test-tenant': tenant, 'x-test-perms': perms.join(',') } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

const codeOf = (res) => res.body && (res.body.code || (res.body.error && res.body.error.code));
const messageOf = (res) => res.body && (res.body.message || (res.body.error && res.body.error.message));

/**
 * Grava (com commit) um snapshot da métrica de uma empresa. `dimensionKey` vazio = valor principal.
 * opts: { asOfDate, periodStart, periodEnd, value, status, dimensionKey, sourceSnapshotAt }.
 */
// refreshedAt nunca antes da fonte: a M9-D609 trata isso como data no futuro (futureStamp) e esconde o valor.
async function snapshotAt(sup, tenant, { definition, version }, opts) {
  return sup.inTx(tenant, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    return store.recordSnapshot({
      companyId: tenant.companyId, groupId: tenant.groupId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      periodStart: opts.periodStart || opts.asOfDate, periodEnd: opts.periodEnd || opts.asOfDate, asOfDate: opts.asOfDate, dimensionKey: opts.dimensionKey || '',
      valueNumeric: opts.value, status: opts.status || 'OK', sourceSnapshotAt: opts.sourceSnapshotAt || `${opts.asOfDate}T12:00:00Z`,
      refreshedAt: opts.refreshedAt || (opts.sourceSnapshotAt ? new Date(Date.parse(opts.sourceSnapshotAt) + 60000).toISOString() : `${opts.asOfDate}T12:05:00Z`), sourceRefs: opts.sourceRefs || [], calcHash: crypto.createHash('sha256').update(`${definition.id}${opts.asOfDate}${opts.dimensionKey || ''}${opts.value}`).digest('hex'),
    }, tx);
  });
}

module.exports = { startServer, snapshotAt, codeOf, messageOf };
