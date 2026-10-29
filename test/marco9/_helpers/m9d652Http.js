'use strict';

// Servidor Express com o router real de /analytics e autenticação simulada por cabeçalho para os testes de rota da M9-D652 e da M9-D653: as empresas NOVAS
// do ambiente (X e Y, no grupo do seed) e a empresa B (outro grupo, para provar o isolamento). Banco descartável (127.0.0.1).
const http = require('node:http');
const express = require('express');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

async function start(env) {
  const tenants = { X: env.cX, Y: env.cY, B: env.tenantB };
  const fakeAuth = (req, res, next) => {
    req.auth = { ...tenants[req.get('x-test-tenant') || 'X'], roles: [], permissions: (req.get('x-test-perms') || '').split(',').filter(Boolean) };
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
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, url, { perms = [], tenant = 'X' } = {}) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'x-test-tenant': tenant, 'x-test-perms': perms.join(',') } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { start };
