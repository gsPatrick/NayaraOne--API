'use strict';

// M9-D902 x M9-D901 — a Torre mostra o RACI incompleto como blocker, atividade por atividade, e o fecha quando a matriz fica completa. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');
const { cleanMigration } = require('../_helpers/m9d900Clean');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { await cleanMigration(); tenants = await env.loadTenants(); } });
// a Torre lê tudo da empresa: antes e depois, neutraliza o resíduo de migração dos outros arquivos e deixa o seu
after(async () => { if (env.DISPOSABLE) await cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const raciBlockers = (tower) => tower.blockers.filter((b) => b.code === 'GOV_MIG_RACI_INCOMPLETE');

test('m9d902 atividade sem R ou sem A fica bloqueada na Torre', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  await env.setRaci(A(), 'GO_NO_GO', []);
  await env.setRaci(A(), 'ROLLBACK_EXECUTION', [{ userId: A().userId, raci: 'A' }]);
  await env.setRaci(A(), 'LEGACY_DECOMMISSION', [{ role: 'TI', raci: 'R' }]);
  await env.setRaci(A(), 'USER_COMMUNICATION', [{ userId: A().userId, raci: 'A' }, { role: 'TI', raci: 'R' }]);
  const tower = await env.getTower(A(), runId);
  const byRef = Object.fromEntries(raciBlockers(tower).map((b) => [b.ref, b]));
  assert.deepEqual(byRef.GO_NO_GO.detail.missing, ['A', 'R']);
  assert.deepEqual(byRef.ROLLBACK_EXECUTION.detail.missing, ['R']);
  assert.deepEqual(byRef.LEGACY_DECOMMISSION.detail.missing, ['A']);
  assert.equal(byRef.USER_COMMUNICATION, undefined, 'matriz completa não bloqueia');
  assert.equal(byRef.GO_NO_GO.entity, null);
  assert.ok(byRef.GO_NO_GO.since);
  await env.setRaci(A(), 'ROLLBACK_EXECUTION', [{ userId: A().userId, raci: 'A' }, { role: 'TI', raci: 'R' }]);
  const healed = await env.getTower(A(), runId);
  assert.ok(!raciBlockers(healed).some((b) => b.ref === 'ROLLBACK_EXECUTION'), 'o blocker fecha com a matriz completa');
  const closed = await env.q("SELECT closed_at FROM governance.mig_blockers WHERE company_id = $1 AND code = 'GOV_MIG_RACI_INCOMPLETE' AND ref = 'ROLLBACK_EXECUTION' ORDER BY since DESC LIMIT 1", [A().companyId]);
  assert.ok(closed[0].closed_at, 'o fechamento fica registrado');
  const audited = await env.q("SELECT action FROM audit.audit_log WHERE company_id = $1 AND action IN ('migration.blocker.opened', 'migration.blocker.closed') AND after_json->>'code' = 'GOV_MIG_RACI_INCOMPLETE'", [A().companyId]);
  assert.ok(audited.some((a) => a.action === 'migration.blocker.opened') && audited.some((a) => a.action === 'migration.blocker.closed'), 'abertura e fechamento são auditados');
  legacy.dispose();
});

test('m9d902 matriz completa nas atividades semeadas não deixa blocker de RACI', { skip: skip() }, async () => {
  const codes = ['FREEZE_LEGACY_WRITES', 'LAST_DELTA_LOAD', 'FINAL_RECONCILIATION', 'PARALLEL_COMPARE_CLOSE', 'SECTOR_ACTIVATION', 'CLOCK_TZ_CHECK', 'GO_NO_GO', 'ROLLBACK_EXECUTION', 'USER_COMMUNICATION', 'LEGACY_DECOMMISSION'];
  for (const code of codes) await env.setRaci(A(), code, [{ userId: A().userId, raci: 'A' }, { role: 'TI', raci: 'R' }]);
  const tower = await env.getTower(A(), null);
  assert.deepEqual(raciBlockers(tower), []);
});
