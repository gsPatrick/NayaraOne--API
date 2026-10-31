'use strict';

// M9-D901 — isolamento entre empresas: contadores, blockers e registros de uma empresa não aparecem nem se alteram pela outra (RLS). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

test('m9d901 isolamento entre empresas', { skip: skip() }, async () => {
  const { A, B } = tenants;
  const legacy = await env.installSource(A, { entity: 'PERSON' });
  await env.seedRecords(A, legacy.system, 'PERSON', { QUARANTINED: 3, MIGRATED: 2 });
  const runA = await env.newRun(A, legacy.system, 'PERSON');
  const towerA = await env.getTower(A, runA);
  assert.equal(towerA.totals.total, 5);
  const rec = (await env.recordsOf(legacy.system))[0];
  // a empresa B pede a execução da A: 404; vê contadores e registros só dela
  const err = await env.fail(env.getTower(B, runA));
  assert.deepEqual([err.statusCode, err.code], [404, 'GOV_NOT_FOUND']);
  const seen = await env.openTenantTx(B, (tx) => env.sequelize.query('SELECT (SELECT count(*) FROM governance.mig_counters WHERE source_system = :s)::int AS c, (SELECT count(*) FROM governance.mig_records WHERE source_system = :s)::int AS r, (SELECT count(*) FROM governance.mig_blockers WHERE entity = \'PERSON\' AND (detail->>\'source_system\') = :s)::int AS b', { type: 'SELECT', transaction: tx, replacements: { s: legacy.system } }));
  assert.deepEqual([seen[0].c, seen[0].r, seen[0].b], [0, 0, 0]);
  await env.setReconciliationRaci(B, B.userId, []);
  const denied = await env.fail(env.resolve(B, { userId: B.userId, roles: [] }, rec.id, { decision: 'EXCLUDE', reason: 'Tentando mexer em outra empresa.' }));
  assert.deepEqual([denied.statusCode, denied.code], [404, 'GOV_NOT_FOUND']);
  assert.notEqual((await env.stateOf(rec.id)).state, 'EXCLUDED');
  const towerB = await env.getTower(B, null);
  assert.ok(towerB.totals.total === 0 || !JSON.stringify(towerB).includes(legacy.system));
  legacy.dispose();
});
