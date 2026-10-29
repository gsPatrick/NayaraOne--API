'use strict';

// Apoio dos testes da M9-D701 (exportação do BI): empresas A e B de CI, dois usuários da A (quem pede e outro) com papel de teste que tem as permissões
// do BI, servidor Express com o router REAL de /analytics (autenticação simulada por cabeçalho), indicador publicado com séries e limpeza. Banco descartável.
const http = require('node:http');
const express = require('express');
const { authenticator } = require('otplib');
const env697 = require('./m9d697Env');
const { sequelize } = require('../../testHelpers');
const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
const { correlationIdMiddleware } = require('../../../src/middlewares/correlationId.middleware');
const tenantMiddleware = require('../../../src/middlewares/tenant.middleware');
const errorHandler = require('../../../src/middlewares/errorHandler');
const store = require('../../../src/features/analytics/metricStore.service');
const mfaService = require('../../../src/features/users/mfa.service');
const diskStorage = require('../../../src/utils/diskStorage');

const { sup, TODAY } = env697;
const PERMS = ['analytics:read', 'analytics:export', 'analytics:drilldown', 'analytics:read:group', 'finance:read', 'crm:opportunities:read', 'legal:read'];

async function userId(env, email) {
  return (await env.admin.query('SELECT id FROM core.users WHERE email = :email', { replacements: { email } }))[0][0].id;
}

async function ciTenant(env, key) {
  const [[c]] = await env.admin.query(`SELECT c.id AS "companyId", c.group_id AS "groupId" FROM core.companies c WHERE c.name = :name`, { replacements: { name: `CI — Empresa Fictícia ${key}` } });
  return { ...c, userId: await userId(env, emailFor(key, 'maker')), otherId: await userId(env, emailFor(key, 'checker')) };
}

async function setup() {
  const env = await env697.setup();
  env.A = await ciTenant(env, 'A');
  env.B = await ciTenant(env, 'B');
  env.created.companies.add(env.A.companyId);
  env.created.companies.add(env.B.companyId);
  // papel de teste com as permissões do BI para os dois usuários da empresa A (o worker lê as permissões do BANCO)
  env.restore = [];
  const [[role]] = await env.admin.query(
    `INSERT INTO core.roles (id, group_id, company_id, name, description, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :n, 'QA-M9 D701', now(), now()) RETURNING id`,
    { replacements: { g: env.A.groupId, c: env.A.companyId, n: `QA-M9 D701 ${sup.sfx()}` } }
  );
  env.roleId = role.id;
  for (const code of PERMS) {
    await env.admin.query(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), :r, p.id, now(), now() FROM core.permissions p WHERE p.code = :code`, { replacements: { r: role.id, code } });
  }
  for (const uid of [env.A.userId, env.A.otherId]) {
    const [[m]] = await env.admin.query('SELECT id, role_id FROM core.user_memberships WHERE user_id = :u AND company_id = :c', { replacements: { u: uid, c: env.A.companyId } });
    env.restore.push({ id: m.id, roleId: m.role_id });
    await env.admin.query('UPDATE core.user_memberships SET role_id = :r WHERE id = :id', { replacements: { r: role.id, id: m.id } });
  }
  await startServer(env);
  return env;
}

async function startServer(env) {
  const users = { maker: env.A, checker: { ...env.A, userId: env.A.otherId }, B: env.B };
  const fakeAuth = (req, res, next) => {
    const who = users[req.get('x-test-user') || 'maker'];
    req.auth = { groupId: who.groupId, companyId: who.companyId, userId: who.userId, roles: [], permissions: (req.get('x-test-perms') ?? PERMS.join(',')).split(',').filter(Boolean) };
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
  env.baseUrl = `http://127.0.0.1:${env.server.address().port}/v1`;
  env.http = async (method, url, { user = 'maker', perms, body, raw = false } = {}) => {
    const path = url.startsWith('/v1/') ? url.slice(3) : url; // o endereço assinado já vem com o prefixo /v1
    const res = await fetch(url.startsWith('http') ? url : `${env.baseUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...(perms ? { 'x-test-perms': perms.join(',') } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null) };
  };
}

/** Indicador publicado na empresa A com snapshot FRESH e `series` séries de dimensão (a, b, c...). */
async function metricWithSeries(env, { series = 3, keys, prefix = 'fin' } = {}) {
  const m = await env697.freshMetric(env, env.A, { prefix });
  const list = keys || Array.from({ length: series }, (_x, i) => `s${i + 1}`);
  await sup.inTx(env.A, { commit: true }, async (tx) => {
    await store.enableAnalyticsWriter(tx);
    for (const key of list) {
      await store.recordSnapshot({
        companyId: env.A.companyId, groupId: env.A.groupId, metricId: m.definition.id, metricVersionId: m.version.id, scopeType: 'COMPANY', scopeId: env.A.companyId, dimensionKey: key,
        periodStart: TODAY, periodEnd: TODAY, asOfDate: TODAY, valueNumeric: '10.0000', status: 'OK', sourceSnapshotAt: env697.minutesAgo(5), refreshedAt: env697.minutesAgo(1),
        sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: env697.sha(`d${key}`), filterSignature: 'assinatura', count: 1 }], calcHash: env697.sha(`${m.definition.id}${key}`),
      }, tx);
    }
  });
  return { ...m, keys: list };
}

/** MFA habilitado e verificado agora para o usuário (pelo serviço, nunca pela rota de MFA). */
async function enableMfa(env, tenant, uid) {
  await sup.inTx({ ...tenant, userId: uid }, { commit: true }, async (tx) => {
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
    const { otpauthUri } = await mfaService.setupMfa(uid, ctx, tx);
    const secret = /[?&]secret=([^&]+)/.exec(otpauthUri)[1];
    await mfaService.confirmMfa(uid, authenticator.generate(secret), ctx, tx);
    await mfaService.verifyMfa(uid, authenticator.generate(secret), ctx, tx);
  });
}
const expireMfa = (env, uid) => env.admin.query("UPDATE core.mfa_step_ups SET expires_at = now() - interval '1 minute' WHERE user_id = :u", { replacements: { u: uid } });

const setParam = (env, key, value) => env697.setSetting(env, env.A, key, value);
const jobRow = async (env, id) => (await env.admin.query('SELECT * FROM analytics.export_jobs WHERE id = :id', { replacements: { id } }))[0][0];
const accessRows = async (env, id) => (await env.admin.query('SELECT action, rows_returned, masking_applied, user_id, ip_hash FROM analytics.access_log WHERE resource_code = :id ORDER BY occurred_at, id', { replacements: { id } }))[0];
const auditRows = async (env, id) => (await env.admin.query('SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_id = :id ORDER BY created_at', { replacements: { id } }))[0];
const eventTypes = async (env, id) => (await env.admin.query("SELECT event_type FROM integration.outbox_events WHERE aggregate_id = :id AND event_type LIKE 'analytics.export.%' ORDER BY created_at", { replacements: { id } }))[0].map((r) => r.event_type);
const fileOf = async (env, fileId) => (await env.admin.query('SELECT id, storage_key AS "storageKey", file_name AS "fileName", deleted_at AS "deletedAt" FROM people.files WHERE id = :id', { replacements: { id: fileId } }))[0][0];

async function teardown(env) {
  await new Promise((resolve) => env.server.close(resolve));
  const companies = [env.A.companyId, env.B.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const [files] = await env.admin.query("SELECT storage_key FROM people.files WHERE company_id IN (:c) AND storage_key LIKE 'analytics-exports/%'", { replacements: { c: companies }, transaction });
    for (const f of files) { try { diskStorage.deleteFile(f.storage_key); } catch (_e) { /* já apagado */ } }
    await env.admin.query("DELETE FROM people.files WHERE company_id IN (:c) AND storage_key LIKE 'analytics-exports/%'", { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM analytics.dashboard_widgets WHERE dashboard_id IN (SELECT id FROM analytics.dashboard_definitions WHERE dashboard_code LIKE 'm9d701_%')", { transaction });
    await env.admin.query("DELETE FROM analytics.dashboard_definitions WHERE dashboard_code LIKE 'm9d701_%'", { transaction });
    await env.admin.query('DELETE FROM analytics.export_jobs WHERE company_id IN (:c)', { replacements: { c: companies }, transaction });
    await env.admin.query('DELETE FROM analytics.access_log WHERE company_id IN (:c)', { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM core.notifications WHERE company_id IN (:c) AND title LIKE '%exportação%'", { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM audit.audit_log WHERE company_id IN (:c) AND action LIKE 'analytics.export.%'", { replacements: { c: companies }, transaction });
    await env.admin.query("DELETE FROM integration.outbox_events WHERE company_id IN (:c) AND event_type LIKE 'analytics.export.%'", { replacements: { c: companies }, transaction });
    await env.admin.query('DELETE FROM core.mfa_step_ups WHERE user_id IN (:u)', { replacements: { u: [env.A.userId, env.A.otherId] }, transaction });
    await env.admin.query('DELETE FROM core.mfa_credentials WHERE user_id IN (:u)', { replacements: { u: [env.A.userId, env.A.otherId] }, transaction });
    for (const r of env.restore) await env.admin.query('UPDATE core.user_memberships SET role_id = :r WHERE id = :id', { replacements: { r: r.roleId, id: r.id }, transaction });
    await env.admin.query('DELETE FROM core.role_permissions WHERE role_id = :r', { replacements: { r: env.roleId }, transaction });
    await env.admin.query('DELETE FROM core.roles WHERE id = :r', { replacements: { r: env.roleId }, transaction });
    await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id IN (:c) AND key LIKE 'analytics.export.%'", { replacements: { c: companies }, transaction });
  });
  await env697.teardown(env);
}

/** Publica (pela rota real) um painel FINANCE com a faixa de qualidade e um cartão do indicador; devolve o código do painel. */
async function publishPanel(env, metricCode) {
  const dashboardCode = `m9d701_${sup.sfx()}`;
  const res = await env.http('POST', '/analytics/dashboards', {
    perms: [...PERMS, 'analytics:manage'],
    body: { dashboardCode, name: 'Painel de teste D701', domain: 'FINANCE', requiredPermission: 'finance:read', p95TargetMs: 1500,
      widgets: [{ widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados' }, { widgetType: 'KPI_CARD', title: 'Cartão', metricCode, valueNature: 'ACTUAL', drilldownEnabled: false }] },
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`painel não publicado: ${res.status} ${JSON.stringify(res.body)}`);
  return dashboardCode;
}

/** Roda a fila da empresa A até esvaziar. */
const runWorker = (env, options) => require('../../../src/features/analytics/exports').runExportWorker({ groupId: env.A.groupId, companyId: env.A.companyId }, options);
/** Pede, roda o worker e devolve { id, job } (job já no estado final). */
async function requestAndRun(env, body, options) {
  const res = await env.http('POST', '/analytics/exports', { body });
  if (res.status !== 202) throw new Error(`pedido recusado: ${res.status} ${JSON.stringify(res.body)}`);
  const results = await runWorker(env, options);
  return { id: res.body.data.jobId, results, job: await jobRow(env, res.body.data.jobId) };
}

module.exports = { ...env697, publishPanel, runWorker, requestAndRun, setup, teardown, metricWithSeries, enableMfa, expireMfa, setParam, jobRow, accessRows, auditRows, eventTypes, fileOf, PERMS, sequelize };
