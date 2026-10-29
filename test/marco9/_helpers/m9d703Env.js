'use strict';

// Apoio dos testes da M9-D703 (GET /analytics/alerts e POST /analytics/alerts/:id/ack): servidor Express com o router real de /analytics e
// autenticação simulada por cabeçalhos (empresa, permissões e usuário), mais alertas abertos pelo motor real. Banco descartável (127.0.0.1).
const http = require('node:http');
const express = require('express');
const base = require('./m9d692Env');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');

async function setup() {
  const env = await base.setup();
  const tenants = { A: env.tenantA, B: env.tenantB };
  const fakeAuth = (req, res, next) => {
    const t = tenants[req.get('x-test-tenant') || 'A'];
    req.auth = { ...t, userId: req.get('x-test-user') || t.userId, roles: [], permissions: (req.get('x-test-perms') || '').split(',').filter(Boolean) };
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
  const baseUrl = `http://127.0.0.1:${env.server.address().port}/v1`;
  env.call = async (method, url, { perms = [], tenant = 'A', user = null, body } = {}) => {
    const headers = { 'Content-Type': 'application/json', 'x-test-tenant': tenant, 'x-test-perms': perms.join(',') };
    if (user) headers['x-test-user'] = user;
    const res = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return env;
}

async function teardown(env) {
  await new Promise((resolve) => env.server.close(resolve));
  await base.teardown(env);
}

/** Escrita do worker de BI pelo superusuário (o gatilho só deixa mudar o estado da instância com a GUC do worker), para montar estados nos testes. */
async function asWorker(env, sql, replacements) {
  return env.admin.transaction(async (transaction) => {
    await env.admin.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
    return env.admin.query(sql, { replacements, transaction });
  });
}

const READ = ['analytics:read', 'finance:read', 'legal:read'];
const ACK = [...READ, 'analytics:alert:ack'];
const at = (hhmm, day = '2026-10-29') => new Date(`${day}T${hhmm}:00Z`).toISOString();

/**
 * Abre (pelo motor real) um alerta da empresa e devolve { metric, def, role, member, instance, step }. `prefix` define o domínio da métrica (fin = FINANCE, legal =
 * LEGAL); `member` é um usuário ativo do papel owner, o único (além de quem tem analytics:alert:manage) que pode reconhecer.
 */
async function openAlert(env, tenant, { prefix = 'fin', severity = 'WARNING', hhmm = '10:00', value = '1000', createTask = false, autoResolve = {}, extraMembers = 0 } = {}) {
  const metric = await base.publish(env, tenant, { prefix, criticality: 'CRITICAL' });
  const role = await base.makeRole(env, tenant);
  const member = await base.makeUser(env, tenant, { role });
  const others = [];
  for (let i = 0; i < extraMembers; i += 1) others.push(await base.makeUser(env, tenant, { role }));
  const def = await base.define(env, tenant, metric, { severity, ownerRole: role.name, createTask, autoResolve });
  const step = async (time, v, day) => {
    await base.put(tenant, metric, { value: v, at: at(time, day), asOfDate: (day || '2026-10-29') });
    return base.evaluate(tenant, at(time, day));
  };
  await step(hhmm, value);
  const [instance] = await base.instances(env, tenant, def);
  return { metric, def, role, member, others, instance, step };
}

module.exports = { ...base, setup, teardown, openAlert, asWorker, READ, ACK, at };
