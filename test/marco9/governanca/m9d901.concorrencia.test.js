'use strict';

// M9-D901 — contadores corretos sob concorrência: dois lotes de fontes diferentes ao mesmo tempo e decisões simultâneas sobre o mesmo contador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const live = async (system) => Object.fromEntries((await env.q('SELECT state, count(*)::int AS n FROM governance.mig_records WHERE company_id = $1 AND source_system = $2 GROUP BY state', [A().companyId, system])).map((r) => [r.state, r.n]));

test('m9d901 contadores corretos sob dois lotes concorrentes', { skip: skip() }, async () => {
  const person = await env.installSource(A(), { entity: 'PERSON' });
  const supplier = await env.installSource(A(), { entity: 'SUPPLIER', system: person.system });
  for (let i = 1; i <= 40; i += 1) {
    person.fake.event(`${i}`, 'I', i, i % 10 === 0 ? env.personRecord({ legalName: '' }) : env.personRecord());
    supplier.fake.event(`${i}`, 'I', i, i % 8 === 0 ? env.personRecord({ legalName: '' }) : env.personRecord({ taxId: env.cnpj(), personType: 'PJ' }));
  }
  await Promise.all([env.run(A(), { sourceSystem: person.system, entity: 'PERSON' }), env.run(A(), { sourceSystem: person.system, entity: 'SUPPLIER' })]);
  const tower = await env.getTower(A(), await env.newRun(A(), person.system));
  assert.equal(tower.totals.total, 80);
  assert.deepEqual([tower.by_entity.PERSON.quarantined, tower.by_entity.SUPPLIER.quarantined], [4, 5]);
  assert.deepEqual([tower.by_entity.PERSON.migrated, tower.by_entity.SUPPLIER.migrated], [36, 35]);
  const rows = await live(person.system);
  assert.equal(tower.totals.migrated, rows.MIGRATED);
  assert.equal(tower.invariants.ok, true, 'os contadores materializados batem com a contagem direta');
  assert.equal((await env.recount(A())).corrected, 0, 'a conferência não precisa corrigir nada');
  person.dispose(); supplier.dispose();
});

test('m9d901 vinte decisões simultâneas no mesmo contador somam exatamente', { skip: skip() }, async () => {
  await env.setReconciliationRaci(A(), A().userId, [{ role: 'FINANCEIRO', raci: 'R' }]);
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { QUARANTINED: 20 }, { payload: env.personRecord({ legalName: '' }) });
  const ids = (await env.recordsOf(legacy.system)).map((r) => r.id);
  const results = await Promise.all(ids.map((id) => env.fail(env.resolve(A(), { userId: A().userId, roles: [] }, id, { decision: 'REPROCESS', reason: 'Em lote.' }))));
  assert.deepEqual(results.filter(Boolean), [], 'nenhuma falhou');
  const tower = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  assert.deepEqual([tower.totals.quarantined, tower.totals.not_started, tower.totals.total], [0, 20, 20]);
  assert.equal(tower.invariants.ok, true);
  legacy.dispose();
});

test('m9d901 duas decisões ao mesmo tempo no mesmo registro: uma vence e a outra recebe 409', { skip: skip() }, async () => {
  await env.setReconciliationRaci(A(), A().userId, []);
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { QUARANTINED: 1 }, { payload: env.personRecord({ legalName: '' }) });
  const [rec] = await env.recordsOf(legacy.system);
  const actor = { userId: A().userId, roles: [] };
  const out = await Promise.all([
    env.fail(env.resolve(A(), actor, rec.id, { decision: 'REPROCESS', reason: 'A' })),
    env.fail(env.resolve(A(), actor, rec.id, { decision: 'SEND_TO_REVIEW', reason: 'B' })), // depois de qualquer das duas, a outra deixa de caber no estado
  ]);
  assert.equal(out.filter(Boolean).length, 1);
  assert.equal(out.find(Boolean).code, 'GOV_MIG_RECORD_INVALID_TRANSITION');
  const audit = await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = $1 AND action = 'migration.record.resolved'", [rec.id]);
  assert.equal(audit[0].n, 1);
  legacy.dispose();
});
