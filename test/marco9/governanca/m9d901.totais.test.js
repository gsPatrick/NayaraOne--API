'use strict';

// M9-D901 — Torre de controle: totais, invariantes, escopo por execução e blockers de contagem. Banco descartável (os testes commitam dados).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;

test('m9d901 Control Tower totals fecham com o total', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 7200, RECONCILED: 300, QUARANTINED: 120, PENDING_REVIEW: 80, PENDING: 2300 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const tower = await env.getTower(A(), runId);
  assert.deepEqual(tower.totals, { total: 10000, migrated: 7500, reconciled: 300, quarantined: 120, pending_review: 80, excluded: 0, not_started: 2300 });
  const t = tower.totals;
  assert.equal(t.total, t.migrated + t.quarantined + t.pending_review + t.excluded + t.not_started, 'a soma fecha com o total');
  assert.deepEqual(tower.by_entity.PERSON, tower.totals, 'por entidade bate com o total quando há uma só entidade');
  assert.equal(tower.run_id, runId);
  assert.equal(tower.invariants.ok, true);
  legacy.dispose();
});

test('m9d901 reconciliado nunca excede migrado', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 5, RECONCILED: 3 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const tower = await env.getTower(A(), runId);
  assert.deepEqual([tower.totals.migrated, tower.totals.reconciled], [8, 3]);
  assert.ok(tower.totals.reconciled <= tower.totals.migrated);
  // contador adulterado a ponto de reconciliados passarem de migrados: a Torre acusa
  await env.q("UPDATE governance.mig_counters SET n = 0 WHERE company_id = $1 AND source_system = $2 AND state = 'MIGRATED'", [A().companyId, legacy.system]);
  await env.q("UPDATE governance.mig_counters SET n = -2 WHERE company_id = $1 AND source_system = $2 AND state = 'RECONCILED'", [A().companyId, legacy.system]);
  const broken = await env.getTower(A(), runId);
  assert.equal(broken.invariants.ok, false);
  assert.ok(env.codesOf(await env.openBlockers(A(), 'GOV_MIG_TOTALS_INCONSISTENT')).length >= 1);
  legacy.dispose();
});

test('m9d901 contadores que não somam o total abrem o blocker e o job de conferência os refaz', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 9000, PENDING: 990 });
  await env.q("UPDATE governance.mig_counters SET n = n - 10 WHERE company_id = $1 AND source_system = $2 AND state = 'MIGRATED'", [A().companyId, legacy.system]);
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const tower = await env.getTower(A(), runId);
  const blocker = tower.blockers.find((b) => b.code === 'GOV_MIG_TOTALS_INCONSISTENT');
  assert.ok(blocker, 'contadores somam 9.990 de 10.000? aqui somam 9.980 de 9.990');
  assert.deepEqual([blocker.entity, blocker.detail.live_total, blocker.detail.counters_sum], ['PERSON', 9990, 9980]);
  assert.ok(blocker.since && 'owner' in blocker);
  const fixed = await env.recount(A());
  assert.ok(fixed.corrected >= 1);
  const healed = await env.getTower(A(), runId);
  assert.equal(healed.totals.total, 9990);
  assert.equal(healed.totals.migrated, 9000);
  assert.ok(!healed.blockers.some((b) => b.code === 'GOV_MIG_TOTALS_INCONSISTENT'), 'o blocker fecha quando os contadores voltam a bater');
  legacy.dispose();
});

test('m9d901 registro EXCLUDED não gera blocker e fecha a soma do total', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 10, EXCLUDED: 4 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const tower = await env.getTower(A(), runId);
  assert.equal(tower.totals.excluded, 4);
  assert.equal(tower.totals.total, 14);
  assert.equal(tower.totals.total, tower.totals.migrated + tower.totals.quarantined + tower.totals.pending_review + tower.totals.excluded + tower.totals.not_started);
  assert.equal(tower.excluded_summary.count, 4, 'aparecem à parte no resumo');
  assert.ok(!tower.blockers.some((b) => /QUARANTINE|REVIEW/.test(b.code)), 'excluídos não bloqueiam');
  legacy.dispose();
});

test('m9d901 a Torre separa as entidades e soma o total do escopo da execução', { skip: skip() }, async () => {
  const person = await env.installSource(A(), { entity: 'PERSON' });
  const supplier = await env.installSource(A(), { entity: 'SUPPLIER', system: person.system });
  await env.seedRecords(A(), person.system, 'PERSON', { MIGRATED: 6, PENDING: 2 });
  await env.seedRecords(A(), person.system, 'SUPPLIER', { RECONCILED: 3, QUARANTINED: 1 });
  const all = await env.getTower(A(), await env.newRun(A(), person.system));
  assert.deepEqual(all.totals, { total: 12, migrated: 9, reconciled: 3, quarantined: 1, pending_review: 0, excluded: 0, not_started: 2 });
  assert.equal(all.by_entity.PERSON.total, 8);
  assert.equal(all.by_entity.SUPPLIER.total, 4);
  const only = await env.getTower(A(), await env.newRun(A(), person.system, 'SUPPLIER'));
  assert.equal(only.totals.total, 4);
  assert.deepEqual(Object.keys(only.by_entity), ['SUPPLIER']);
  person.dispose(); supplier.dispose();
});

test('m9d901 quarentena e revisão abrem blocker por entidade e a pendência de reconciliação aparece desde o início', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 5, RECONCILED: 2, QUARANTINED: 1, PENDING_REVIEW: 1 });
  const tower = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  const codes = tower.blockers.map((b) => b.code);
  for (const code of ['GOV_MIG_QUARANTINE_OPEN', 'GOV_MIG_REVIEW_PENDING', 'GOV_MIG_RECONCILIATION_PENDING']) assert.ok(codes.includes(code), code);
  const rec = tower.blockers.find((b) => b.code === 'GOV_MIG_RECONCILIATION_PENDING');
  assert.equal(rec.detail.pending, 5, 'migrated menos reconciled');
  assert.deepEqual(Object.keys(rec).sort(), ['code', 'detail', 'entity', 'owner', 'ref', 'since']);
  assert.deepEqual(tower.pending_human, { quarantined: 1, pending_review: 1 });
  legacy.dispose();
});
