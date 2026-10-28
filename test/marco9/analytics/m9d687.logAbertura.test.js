'use strict';

// M9-D687 + M9-D700 — abrir painel registra o acesso (CRITICAL por padrão; TODOS por parâmetro). Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/analytics/m9d687.logAbertura.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { sequelize } = sup;
let env;

before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const A = () => env.tenantA;

async function logOf(where, replacements = {}) {
  const [rows] = await env.admin.query(`SELECT * FROM analytics.access_log WHERE ${where} ORDER BY occurred_at`, { replacements });
  return rows;
}

async function setParam(key, value) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: A().groupId, c: A().companyId, u: A().userId }, transaction });
    await upsertSetting(key, value, A(), A().userId, transaction);
  });
}

test('m9d687 abrir painel CRITICAL gera log; o parâmetro TODOS registra qualquer abertura', async () => {
  const perms = ['analytics:read', 'finance:read', 'analytics:manage'];
  const { metricCode, cleanup } = await sup.publishTestMetric(env, { prefix: 'fin', criticality: 'CRITICAL' });
  const normal = await sup.publishTestMetric(env, { prefix: 'fin', criticality: 'NORMAL' });
  try {
    const critico = sup.panelBody({ widgets: [sup.BANNER, { widgetType: 'KPI_CARD', title: 'K', metricCode }] });
    const comum = sup.panelBody({ widgets: [sup.BANNER, { widgetType: 'KPI_CARD', title: 'K', metricCode: normal.metricCode }] });
    for (const body of [critico, comum]) assert.equal((await env.call('POST', '/analytics/dashboards', { perms, body })).status, 201);
    assert.equal((await env.call('GET', `/analytics/dashboards/${critico.dashboardCode}`, { perms })).status, 200);
    assert.equal((await env.call('GET', `/analytics/dashboards/${comum.dashboardCode}`, { perms })).status, 200);
    assert.equal((await logOf("action = 'DASHBOARD_OPEN' AND resource_code = :c", { c: critico.dashboardCode })).length, 1);
    assert.equal((await logOf("action = 'DASHBOARD_OPEN' AND resource_code = :c", { c: comum.dashboardCode })).length, 0, 'painel sem indicador crítico não loga no padrão');
    await setParam('analytics.log_acesso.abertura_painel', 'TODOS');
    try {
      await env.call('GET', `/analytics/dashboards/${comum.dashboardCode}`, { perms });
      assert.equal((await logOf("action = 'DASHBOARD_OPEN' AND resource_code = :c", { c: comum.dashboardCode })).length, 1);
    } finally { await setParam('analytics.log_acesso.abertura_painel', 'CRITICAL'); }
  } finally { cleanup(); normal.cleanup(); }
});

