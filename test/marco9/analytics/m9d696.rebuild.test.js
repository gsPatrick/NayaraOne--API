'use strict';

// M9-D696 (critério 6) — os checks do catálogo rodam sobre a TABELA SOMBRA do rebuild (M9-D608), registrados com onRebuildChecks, e um check
// BLOCK que falha aborta a reconstrução com ANALYTICS_REBUILD_QUALITY_FAILED. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env608 = require('../_helpers/m9d608Env');
const readModels = require('../../../src/features/analytics/read-models');
const quality = require('../../../src/features/analytics/quality');

const { addSource, applyCommitted, tableRows, ctxFor, shadowExists } = env608;
let env;
let buggy = false;

before(async () => {
  env = await env608.setup();
  await addSource(env, env.tenantA, 'caixa', '1000.00');
  await addSource(env, env.tenantA, 'banco', '250.50');
  await applyCommitted(env, env.tenantA, 'caixa');
  await applyCommitted(env, env.tenantA, 'banco');
  const original = env.def.recompute;
  env.def.recompute = async (args) => {
    const r = await original(args);
    return buggy ? { ...r, fields: { ...r.fields, balance: '1.00' } } : r; // recálculo errado: o read model deixa de bater com a fonte
  };
  const { types } = quality;
  quality.registerChecks(env.model, [
    types.reconciliation({
      code: 'soma_saldos', metrics: ['fin.free_cash'], kind: 'MONEY',
      expected: async (ctx) => quality.sql.value(ctx, `SELECT COALESCE(SUM(balance), 0)::text AS v FROM analytics.${ctx.table} WHERE company_id = :companyId`),
      observed: async (ctx) => quality.sql.value(ctx, `SELECT COALESCE(SUM(amount), 0)::text AS v FROM analytics.${env.source} WHERE company_id = :companyId`),
    }),
    types.freshness({ code: 'frescor', domain: 'FINANCE', metrics: ['fin.free_cash'] }),
  ]);
});
after(() => env608.teardown(env));

const run = (reason) => readModels.rebuildReadModel(ctxFor(env.tenantA, { reason }), { model: env.model, companyId: env.tenantA.companyId });
const rebuildChecks = async () => (await env.admin.query(
  `SELECT q.* FROM analytics.data_quality_checks q JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
    WHERE q.read_model = :m AND r."trigger" = 'REBUILD' ORDER BY q.executed_at, q.created_at`, { replacements: { m: env.model } }
))[0];

test('m9d696 check roda sobre a tabela sombra do rebuild', async () => {
  const before1 = await tableRows(env, env.tenantA);
  await env.admin.query(`DELETE FROM analytics.data_quality_checks WHERE read_model = '${env.model}'`);
  const out = await run('conferência da D696');
  assert.equal(out.status, 'SUCCEEDED');
  const saved = await env.admin.query(`SELECT q.*, r."trigger" FROM analytics.data_quality_checks q JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id WHERE q.read_model = '${env.model}'`);
  const rows = saved[0];
  assert.equal(rows.length, 2, 'os dois checks do catálogo rodaram no rebuild');
  assert.ok(rows.every((r) => r.trigger === 'REBUILD' && r.status === 'PASSED' && r.refresh_id === out.refreshId));
  const rec = rows.find((r) => r.check_code === 'soma_saldos');
  assert.equal(rec.observed.table, `${env.model}__rebuild`, 'lido da sombra, não da tabela atual');
  assert.deepEqual(await tableRows(env, env.tenantA), before1);
});

test('m9d696 check BLOCK que falha na sombra aborta o rebuild com ANALYTICS_REBUILD_QUALITY_FAILED', async () => {
  const before1 = await tableRows(env, env.tenantA);
  buggy = true;
  try {
    await assert.rejects(run('com recálculo errado'), (e) => { assert.equal(e.code, 'ANALYTICS_REBUILD_QUALITY_FAILED'); assert.equal(e.statusCode, 422); return true; });
  } finally {
    buggy = false;
  }
  assert.deepEqual(await tableRows(env, env.tenantA), before1, 'a tabela atual ficou intacta');
  assert.equal(await shadowExists(env), false, 'a sombra foi descartada');
  const failed = (await rebuildChecks()).filter((c) => c.status === 'FAILED');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].check_code, failed[0].severity, failed[0].check_type], ['soma_saldos', 'CRITICAL', 'RECONCILIATION']);
  assert.equal(failed[0].observed.value, '1250.50');
  assert.equal(failed[0].expected.value, '2.00');
});
