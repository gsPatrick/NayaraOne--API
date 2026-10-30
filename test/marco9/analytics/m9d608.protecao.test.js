'use strict';

// M9-D608 — proteções do rebuild: permissão, parâmetro (LAB x produção), lock por read model, motivo da diferença, check de qualidade
// sobre a sombra, isolamento entre empresas, auditoria e evento. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env608 = require('../_helpers/m9d608Env');
const readModels = require('../../../src/features/analytics/read-models');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { addSource, applyCommitted, tableRows, ctxFor, lastRefresh, shadowExists, shadowOf } = env608;
let env;

before(async () => {
  env = await env608.setup();
  await addSource(env, env.tenantA, 'caixa', '1000.00');
  await applyCommitted(env, env.tenantA, 'caixa');
});
after(() => env608.teardown(env));

const run = (tenant, { reason = null, permissions, hooks, companyId } = {}) => readModels.rebuildReadModel(
  ctxFor(tenant, { reason, ...(permissions ? { permissions } : {}) }), { model: env.model, companyId: companyId || tenant.companyId, hooks }
);
const setFlag = (value) => env608.inTx(env.tenantA, { commit: true }, (tx) => upsertSetting('analytics.rebuild.habilitado', value, env.tenantA, env.tenantA.userId, tx));
const clearFlag = () => env.admin.query("DELETE FROM core.tenant_settings WHERE key = 'analytics.rebuild.habilitado'");
const rejects = (promise, status, code) => assert.rejects(promise, (e) => { assert.equal(e.code, code, e.message); assert.equal(e.statusCode, status); return true; });

test('m9d608 flag desligada recusa', async () => {
  const before1 = await tableRows(env, env.tenantA);
  await setFlag(false);
  try {
    await rejects(run(env.tenantA), 403, 'ANALYTICS_REBUILD_DISABLED');
    assert.deepEqual(await tableRows(env, env.tenantA), before1);
    assert.equal(await lastRefresh(env, env.tenantA), null, 'recusa antes de abrir o diário');
  } finally {
    await clearFlag();
  }
  assert.equal((await run(env.tenantA)).status, 'SUCCEEDED', 'sem valor gravado, o ambiente de teste (LAB) vale LIGADO');

  // padrão por ambiente: LAB liga, produção e homologação publicada desligam; valor gravado pela empresa vence
  const read = (env2) => env608.inTx(env.tenantA, {}, (tx) => readModels.readRebuildParams(env.tenantA, tx, env2));
  assert.equal((await read({ NODE_ENV: 'development' })).enabled, true);
  assert.equal((await read({ NODE_ENV: 'test' })).enabled, true);
  assert.equal((await read({ NODE_ENV: 'production' })).enabled, false);
  assert.equal((await read({ NODE_ENV: 'test', DEPLOY_ENVIRONMENT: 'production' })).enabled, false);
  assert.equal((await read({ NODE_ENV: 'test', DEPLOY_ENVIRONMENT: 'staging' })).enabled, false);
  await setFlag(true);
  try {
    assert.equal((await read({ NODE_ENV: 'production' })).enabled, true, 'a empresa ligou em produção');
    assert.equal((await read({ NODE_ENV: 'production' })).reapplyWindowMinutes, 60);
  } finally {
    await clearFlag();
  }
});

test('m9d608 rebuild simultâneo recebe 409', async (t) => {
  let reached;
  let release;
  const paused = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run(env.tenantA, { hooks: { afterShadow: async () => { reached(); await gate; } } });
  await paused;
  try {
    await rejects(run(env.tenantA), 409, 'ANALYTICS_REBUILD_IN_PROGRESS');
    await run(env.tenantA).catch((e) => t.diagnostic(`segundo pedido: HTTP-equivalente ${e.statusCode} ${e.code}: ${e.message}`));
    await rejects(run(env.tenantA, { reason: 'outro' }), 409, 'ANALYTICS_REBUILD_IN_PROGRESS');
    assert.equal(await shadowExists(env), true, 'o primeiro segue com a sombra pronta; o segundo não mexeu nela');
  } finally {
    release();
  }
  assert.equal((await first).status, 'SUCCEEDED');
  assert.equal((await run(env.tenantA)).status, 'SUCCEEDED', 'terminado o primeiro, o lock é liberado');
});

test('m9d608 check de qualidade falho aborta e preserva o atual', async () => {
  await addSource(env, env.tenantA, 'caixa', '250.00'); // a sombra vai diferir da atual
  const before1 = await tableRows(env, env.tenantA);
  const calls = [];
  const off = readModels.onRebuildChecks(async ({ shadowTable, companyId, refreshId, transaction }) => {
    const [[row]] = await transaction.sequelize.query(`SELECT count(*)::int AS n FROM analytics.${shadowTable} WHERE company_id = :c`, { replacements: { c: companyId }, transaction });
    calls.push({ shadowTable, rows: row.n, refreshId });
    return [{ checkCode: 'reconciliacao_caixa', checkType: 'RECONCILIATION', status: 'FAILED', severity: 'CRITICAL', expected: { total: '1250.00' }, observed: { total: '1000.00' } }];
  });
  try {
    await rejects(run(env.tenantA, { reason: 'conferir' }), 422, 'ANALYTICS_REBUILD_QUALITY_FAILED');
  } finally {
    off();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shadowTable, shadowOf(env));
  assert.equal(calls[0].rows, 1, 'o check enxergou a tabela sombra já preenchida');
  assert.deepEqual(await tableRows(env, env.tenantA), before1, 'a tabela atual ficou como estava');
  assert.equal(await shadowExists(env), false);
  const refresh = await lastRefresh(env, env.tenantA);
  assert.deepEqual([refresh.status, refresh.error_code], ['FAILED', 'ANALYTICS_REBUILD_QUALITY_FAILED']);
  const [[saved]] = await env.admin.query('SELECT status, severity, check_type FROM analytics.data_quality_checks WHERE refresh_id = :r', { replacements: { r: refresh.id } });
  assert.deepEqual([saved.status, saved.severity, saved.check_type], ['FAILED', 'CRITICAL', 'RECONCILIATION'], 'o resultado do check ficou registrado');

  // falha de severidade baixa só registra; erro de execução do check conta como falha crítica
  const warn = readModels.onRebuildChecks(async () => [{ checkCode: 'faixa_linhas', checkType: 'ROW_COUNT_RANGE', status: 'FAILED', severity: 'WARNING', expected: {}, observed: {} }]);
  try {
    assert.equal((await run(env.tenantA, { reason: 'aviso apenas' })).status, 'SUCCEEDED');
  } finally {
    warn();
  }
  await addSource(env, env.tenantA, 'caixa', '1.00');
  const boom = readModels.onRebuildChecks(async () => { throw new Error('consulta do check quebrou'); });
  try {
    await rejects(run(env.tenantA, { reason: 'check com erro' }), 422, 'ANALYTICS_REBUILD_QUALITY_FAILED');
  } finally {
    boom();
  }
});

test('m9d608 diferença exige motivo e o motivo fica gravado com auditoria e evento', async () => {
  await addSource(env, env.tenantA, 'caixa', '10.00');
  const before1 = await tableRows(env, env.tenantA);
  await rejects(run(env.tenantA), 422, 'ANALYTICS_REBUILD_REASON_REQUIRED');
  assert.deepEqual(await tableRows(env, env.tenantA), before1);
  assert.equal((await lastRefresh(env, env.tenantA)).status, 'FAILED');

  const reason = 'Correção do lançamento de origem após erro de integração';
  const ok = await run(env.tenantA, { reason });
  assert.equal(ok.changed, 1);
  assert.notEqual(ok.before.hash, ok.after.hash);
  const refresh = await lastRefresh(env, env.tenantA);
  assert.equal(refresh.rebuild_reason, reason);
  assert.equal(refresh.rebuild_diff.changed, 1);
  assert.equal(refresh.rebuild_diff.before.hash, ok.before.hash);
  const [[audit]] = await env.admin.query("SELECT before_json, after_json, reason, user_id FROM audit.audit_log WHERE action = 'analytics.read_model.rebuilt' AND entity_id = :id", { replacements: { id: refresh.id } });
  assert.equal(audit.before_json.hash, ok.before.hash, 'auditoria com antes e depois (hash e linhas)');
  assert.equal(audit.after_json.hash, ok.after.hash);
  assert.equal(audit.reason, reason);
  assert.equal(audit.user_id, env.tenantA.userId);
  const [[evt]] = await env.admin.query("SELECT payload_json, classification, event_version FROM integration.outbox_events WHERE event_type = 'analytics.read_model.rebuilt' AND aggregate_id = :id", { replacements: { id: refresh.id } });
  assert.equal(evt.payload_json.readModel, env.model);
  assert.equal(evt.payload_json.hashAfter, ok.after.hash);
  assert.equal(evt.payload_json.reason, reason);
});

test('m9d608 permissão analytics:rebuild e escopo da empresa', async () => {
  await rejects(run(env.tenantA, { permissions: ['analytics:read', 'analytics:manage'] }), 403, 'PERMISSION_DENIED');
  await rejects(run(env.tenantA, { permissions: [] }), 403, 'PERMISSION_DENIED');
  await rejects(run(env.tenantA, { companyId: env.tenantB.companyId }), 404, 'ANALYTICS_SCOPE_NOT_FOUND'); // empresa de outro grupo: 404, nunca 403
  await rejects(readModels.rebuildReadModel(ctxFor(env.tenantA), { model: 'rm_nao_existe', companyId: env.tenantA.companyId }), 404, 'ANALYTICS_READ_MODEL_NOT_FOUND');
  const semKeys = `rm_m9d608_semkeys_${env.sfx}`;
  readModels.registerReadModel({ name: semKeys, version: 1, keyColumns: ['account_id'], eventTypes: [], aggregateKey: () => null, recompute: async () => ({ fields: {} }) });
  try {
    await rejects(readModels.rebuildReadModel(ctxFor(env.tenantA), { model: semKeys, companyId: env.tenantA.companyId }), 422, 'ANALYTICS_REBUILD_NOT_SUPPORTED');
  } finally {
    readModels.unregisterReadModel(semKeys);
  }
});

test('m9d608 tabela sombra tem a estrutura da atual, RLS forçada e isolamento por empresa', async () => {
  let seen;
  await addSource(env, env.tenantA, 'caixa', '3.00');
  await run(env.tenantA, {
    reason: 'inspeção da sombra',
    hooks: {
      afterShadow: async () => {
        const [[rls]] = await env.admin.query(`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass('analytics.${shadowOf(env)}')`);
        const [pol] = await env.admin.query(`SELECT cmd FROM pg_policies WHERE schemaname = 'analytics' AND tablename = '${shadowOf(env)}' ORDER BY cmd`);
        const [[idx]] = await env.admin.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'analytics' AND tablename = '${shadowOf(env)}'`);
        const other = await env608.inTx(env.tenantB, {}, async (tx) => (await tx.sequelize.query(`SELECT count(*)::int AS n FROM analytics.${shadowOf(env)}`, { transaction: tx }))[0][0].n);
        seen = { rls, policies: pol.map((p) => p.cmd), indexes: idx.n, otherTenantRows: other };
      },
    },
  });
  assert.deepEqual([seen.rls.enabled, seen.rls.forced], [true, true]);
  assert.deepEqual(seen.policies, ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  assert.ok(seen.indexes >= 1, 'índice único (company_id, chave) copiado');
  assert.equal(seen.otherTenantRows, 0, 'outra empresa não enxerga a sombra');
  await assert.rejects(env.admin.query("SELECT analytics.rebuild_shadow_create('rm_applied_events', '00000000-0000-0000-0000-000000000001')"), /inválido para reconstrução/);
  await assert.rejects(env.admin.query("SELECT analytics.rebuild_shadow_create('core_companies', '00000000-0000-0000-0000-000000000001')"), /inválido para reconstrução/);
  await assert.rejects(env.admin.query("SELECT analytics.rebuild_shadow_create('rm_nao_existe_mesmo', '00000000-0000-0000-0000-000000000001')"), /inexistente/);
});
