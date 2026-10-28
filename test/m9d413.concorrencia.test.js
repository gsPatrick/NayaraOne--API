'use strict';

// M9-D413 — publicações simultâneas (conexões separadas, COMMIT real): uma vence, a outra recebe o resultado, e sobra UMA versão viva.
// Só em banco descartável com DATABASE_ADMIN_URL.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../src/models');
const { withTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d413Fixtures');
const svc = require('../src/modules/marketing/automations/automations.service');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (transações concorrentes COMMITAM)';
let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

async function adminCleanup(flowIds) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id = ANY($1)', [flowIds]);
    await admin.query('DELETE FROM marketing.automation_versions WHERE flow_id = ANY($1)', [flowIds]);
    await admin.query('DELETE FROM marketing.automation_flows WHERE id = ANY($1)', [flowIds]);
  } finally { await admin.end(); }
}

test('publicacoes_simultaneas: a mesma versão em paralelo publica uma vez; versões diferentes terminam com UMA viva', { skip: SKIP }, async () => {
  const tx = (fn) => withTenantTransaction(tenant, fn);
  const first = await tx((t) => svc.createAutomation({ tenant, actor: tenant.userId, input: fx.validBody(tenant) }, t));
  const flowId = first.flow.id;
  try {
    await tx((t) => svc.createAutomation({ tenant, actor: tenant.userId, input: { flowId } }, t));
    await tx((t) => svc.createAutomation({ tenant, actor: tenant.userId, input: { flowId } }, t));
    const run = (versionNo) => tx((t) => svc.publishAutomation({ tenant, actor: tenant.userId, flowId, input: { versionNo, reason: 'Publicação concorrente de teste.' } }, t));
    const same = await Promise.all([run(1), run(1), run(1)]);
    assert.equal(same.filter((r) => r.replay === false).length, 1);
    assert.equal(same.filter((r) => r.replay === true).length, 2);
    const diff = await Promise.all([run(2), run(3)]);
    assert.ok(diff.every((r) => r.replay === false));
    const live = await tx((t) => fx.q(t, "SELECT version_no, status FROM marketing.automation_versions WHERE flow_id = :f AND status IN ('PUBLISHED','PAUSED') ORDER BY version_no", { f: flowId }));
    assert.equal(live.length, 1, 'uma só versão viva por fluxo');
    const statuses = await tx((t) => fx.statuses(t, flowId));
    assert.equal(statuses.filter((s) => s.endsWith('PUBLISHED')).length, 1);
    assert.equal(statuses.filter((s) => s.endsWith('SUPERSEDED')).length, 2);
    const flow = await tx((t) => fx.flowRow(t, flowId));
    assert.equal(flow.status, 'ACTIVE');
    // pausa e publicação simultâneas: o estado final é coerente (fluxo e versão iguais)
    await Promise.allSettled([tx((t) => svc.pauseAutomation({ tenant, actor: tenant.userId, flowId, input: {} }, t)), run(live[0].version_no)]);
    const flowAfter = await tx((t) => fx.flowRow(t, flowId));
    const liveAfter = await tx((t) => fx.q(t, "SELECT status FROM marketing.automation_versions WHERE flow_id = :f AND status IN ('PUBLISHED','PAUSED')", { f: flowId }));
    assert.equal(liveAfter.length, 1);
    assert.equal(flowAfter.status === 'ACTIVE', liveAfter[0].status === 'PUBLISHED');
  } finally {
    await adminCleanup([flowId]);
  }
});
