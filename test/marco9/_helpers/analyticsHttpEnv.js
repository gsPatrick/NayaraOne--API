'use strict';

// Apoio dos testes da M9-D687/M9-D700: servidor Express com o router real de /analytics e autenticação simulada por cabeçalho
// (permissões e empresa), mais as duas empresas da base descartável. Roda SÓ em banco descartável (127.0.0.1).
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Sequelize } = require('sequelize');

const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

const sfx = () => `${uniqueSuffix()}${Math.floor(Math.random() * 1000)}`.replace(/[^a-z0-9]/gi, '').toLowerCase();

async function setup() {
  assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL ausente: rode via scripts/withDisposableDb.js (nunca contra o banco compartilhado).');
  assert.match(process.env.DATABASE_ADMIN_URL, /@127\.0\.0\.1:/, 'o destino precisa ser 127.0.0.1');
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tenantA = await getSeedTenant();
  const [[b]] = await admin.query(`SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = 'CI — Empresa Fictícia B' LIMIT 1`);
  const [[u]] = await admin.query(`SELECT id FROM core.users WHERE email = 'admin@nayaraone.dev'`);
  const tenantB = { groupId: b.groupId, companyId: b.companyId, userId: u.id };

  const tenants = { A: tenantA, B: tenantB };
  // Autenticação simulada: x-test-tenant (A|B) e x-test-perms (lista separada por vírgula).
  const fakeAuth = (req, res, next) => {
    const t = tenants[req.get('x-test-tenant') || 'A'];
    req.auth = { ...t, roles: [], permissions: (req.get('x-test-perms') || '').split(',').filter(Boolean) };
    next();
  };
  const { createAnalyticsRouter } = require('../../../src/features/analytics');
  const router = createAnalyticsRouter({ authChain: [fakeAuth, tenantMiddleware] });
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(express.json());
  app.use('/v1', router);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  async function call(method, url, { perms = [], tenant = 'A', body } = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-tenant': tenant, 'x-test-perms': perms.join(',') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { admin, tenantA, tenantB, tenants, server, router, call };
}

async function teardown(env) {
  await new Promise((resolve) => env.server.close(resolve));
  await env.admin.close();
  await sequelize.close();
}

async function inTx(tenant, { commit = false, writer = false } = {}, fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
    if (writer) await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
    const result = await fn(transaction);
    if (commit) await transaction.commit();
    else await transaction.rollback();
    return result;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

const ctxOf = (t, permissions = []) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions });
const BANNER = { widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados' };
const ALERTS = { widgetType: 'LIST_ALERTS', title: 'Alertas' };
const panelBody = (extra = {}) => ({
  dashboardCode: `m9d687_${sfx()}`, name: 'Painel de teste', domain: 'FINANCE', requiredPermission: 'finance:read', widgets: [BANNER, ALERTS], p95TargetMs: 1500, ...extra, // a meta p95 é obrigatória (M9-D698)
});

/** Publica (commit) uma métrica de teste do domínio indicado pelo prefixo do código e devolve { metricCode, cleanup }. */
async function publishTestMetric(env, { prefix = 'fin', criticality = 'CRITICAL' } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const registry = require('../../../src/features/analytics/metrics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d687-formulas-'));
  const formulaId = `${prefix}.m9d687_soma_${sfx()}`;
  fs.writeFileSync(path.join(dir, 'soma.js'), `module.exports = { id: '${formulaId}', version: 1, compute: () => ({ value: '3' }),
    testCases: [{ name: 'um', input: [], expected: { value: '3' } }] };`);
  const readModel = `rm_m9d687_${sfx()}`;
  await env.admin.query(`CREATE TABLE analytics.${readModel} (id int)`);
  const metricCode = `${prefix}.m9d687_${sfx()}`;
  await inTx(env.tenantA, { commit: true }, (tx) => registry.publishMetric({
    scopeLevel: 'COMPANY', metricCode, name: 'Indicador de teste', description: 'd', formulaId, formulaSemantic: 'soma', sourceReadModel: readModel,
    dimensions: [], filters: {}, unit: 'BRL', ownerRole: 'CFO', refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 60 },
    version: 1, validFrom: '2026-01-01', qualityRule: { referenceReport: 'r' }, valueNature: 'ACTUAL', criticality,
  }, ctxOf(env.tenantA, ['analytics:manage']), tx, { catalog: registry.createFormulaCatalog(dir) }));
  return { metricCode, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { setup, teardown, inTx, ctxOf, sfx, BANNER, ALERTS, panelBody, publishTestMetric, sequelize };
