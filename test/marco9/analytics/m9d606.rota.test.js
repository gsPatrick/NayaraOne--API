'use strict';

// M9-D606 — a rota de métricas valida a data-base pelo resolvedor único: formato inválido e futuro dão 400 com o código do livro.
// Roda no banco descartável (o router carrega os models); as recusas acontecem antes de qualquer consulta.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const clock = require('../../../src/features/analytics/metrics/clock');
const { createAnalyticsRouter } = require('../../../src/features/analytics');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

after(async () => { clock.resetClock(); await sequelize.close(); });

test('m9d606 rota de métrica recusa data-base inválida e futura', async () => {
  const tenant = await getSeedTenant();
  clock.setClock(() => new Date('2026-10-27T17:00:00Z'));
  const auth = (req, res, next) => { req.auth = { ...tenant, permissions: ['analytics:read'] }; next(); };
  const app = express();
  app.use(correlationIdMiddleware);
  app.use('/v1', createAnalyticsRouter({ authChain: [auth, tenantMiddleware] }));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const get = async (qs) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/analytics/metrics/fin.nao_existe${qs}`); return { status: res.status, body: await res.json() }; };
    const future = await get('?asOf=2026-10-28');
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, 'ANALYTICS_AS_OF_FUTURE');
    assert.equal(future.body.error.message, 'A data-base não pode estar no futuro.');
    const bad = await get('?asOf=2026-02-30');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'ANALYTICS_PERIOD_INVALID');
    const today = await get('?asOf=2026-10-27');
    assert.notEqual(today.body.error && today.body.error.code, 'ANALYTICS_AS_OF_FUTURE', 'hoje de SP é válido (a métrica inexistente dá outro erro)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
