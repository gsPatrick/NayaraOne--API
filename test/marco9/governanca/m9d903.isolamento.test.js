'use strict';

// M9-D903 — isolamento entre empresas: janela, regras, execuções, resultados e blockers de uma empresa não aparecem nem se alteram pela outra (RLS). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d903Env');
const windows = require('../../../src/features/migration-v2/parallel/window.repository');
const results = require('../../../src/features/migration-v2/parallel/results.repository');
const report = require('../../../src/features/migration-v2/parallel/report.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d903 isolamento entre empresas', { skip: skip() }, async () => {
  const { A, B } = tenants;
  const s = await env.scenario(A);
  await s.pair('iso-1', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 1 });
  await env.tick(A, s.window.id, env.T0);
  assert.equal((await env.towerBlockers(A, s.system)).length, 1);

  const seen = await env.openTenantTx(B, async (tx) => ({
    window: await windows.get(B, s.window.id, tx), rules: await windows.listRules(B, s.window.id, tx), active: await windows.listActive(B, tx),
    open: await results.openBlockers(B, s.window.id, tx),
    counts: await env.sequelize.query('SELECT (SELECT count(*) FROM governance.parallel_runs)::int AS runs, (SELECT count(*) FROM governance.parallel_results WHERE window_id = :w)::int AS res', { type: 'SELECT', transaction: tx, replacements: { w: s.window.id } }),
  }));
  assert.equal(seen.window, null);
  const raw = await env.openTenantTx(B, (tx) => env.sequelize.query('SELECT (SELECT count(*) FROM governance.parallel_windows WHERE id = :w)::int AS w, (SELECT count(*) FROM governance.parallel_rules WHERE window_id = :w)::int AS r', { type: 'SELECT', transaction: tx, replacements: { w: s.window.id } }));
  assert.deepEqual([raw[0].w, raw[0].r], [0, 0], 'a política de linha da empresa B esconde a janela da A mesmo sem filtro');
  assert.deepEqual([seen.rules.length, seen.open.length, seen.counts[0].res], [0, 0, 0]);
  assert.ok(!seen.active.some((w) => w.id === s.window.id));
  const denied = await env.fail(env.openTenantTx(B, (tx) => report.windowReport(B, s.window.id, {}, tx)));
  assert.deepEqual([denied.statusCode, denied.code], [404, 'GOV_NOT_FOUND']);
  // o job da empresa B não toca a janela da A
  const otherJob = await env.runJob(B, env.minutes(60));
  assert.equal(otherJob.runs, 0);
  assert.equal((await env.runsOf(s.window.id)).length, 1);
  const towerB = await env.openTenantTx(B, (tx) => require('../../../src/features/migration-v2/control/tower.service').getTower(B, { userId: B.userId }, {}, tx));
  assert.ok(!JSON.stringify(towerB.blockers).includes(s.window.id));
  await s.dispose();
});
