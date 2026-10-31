'use strict';

// M9-D901 — máquina de estados do registro de origem e regras de delta (D900 aplica, D901 define). Banco descartável (commita dados).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');
const states = require('../../../src/features/migration-v2/control/record.states');
const transitions = require('../../../src/features/migration-v2/control/record.transition');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const ALL = ['PENDING', 'MIGRATED', 'RECONCILED', 'QUARANTINED', 'PENDING_REVIEW', 'EXCLUDED'];
const ALLOWED = {
  PENDING: ['MIGRATED', 'QUARANTINED', 'PENDING_REVIEW'], QUARANTINED: ['PENDING', 'PENDING_REVIEW', 'EXCLUDED'], PENDING_REVIEW: ['MIGRATED', 'QUARANTINED', 'EXCLUDED'],
  MIGRATED: ['RECONCILED', 'QUARANTINED'], RECONCILED: [], EXCLUDED: [],
};
const valid = (extra = {}) => env.personRecord(extra);

test('m9d901 transição proibida recusada', { skip: skip() }, async () => {
  for (const from of ALL) for (const to of ALL) assert.equal(states.canTransition(from, to), (ALLOWED[from] || []).includes(to), `${from} -> ${to}`);
  assert.equal(states.canTransition('RECONCILED', 'PENDING'), false);
  assert.equal(states.canTransition('PENDING', 'RECONCILED'), false);
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await env.insertRecord(A(), legacy.system, 'PERSON', { key: 'r1', state: 'RECONCILED', payload: valid() });
  const err = await env.fail(env.openTenantTx(A(), (tx) => transitions.transitionRecord(A(), { userId: A().userId }, rec.id, 'PENDING', { reason: 'tentativa' }, tx)));
  assert.deepEqual([err.statusCode, err.code, err.message], [409, 'GOV_MIG_RECORD_INVALID_TRANSITION', 'Transição de estado inválida para o registro migrado.']);
  assert.equal((await env.stateOf(rec.id)).state, 'RECONCILED', 'nada mudou');
  const pending = await env.insertRecord(A(), legacy.system, 'PERSON', { key: 'p1', state: 'PENDING', payload: valid() });
  const err2 = await env.fail(env.openTenantTx(A(), (tx) => transitions.transitionRecord(A(), { userId: A().userId }, pending.id, 'RECONCILED', { reason: 'pular a conferência' }, tx)));
  assert.equal(err2.code, 'GOV_MIG_RECORD_INVALID_TRANSITION');
  legacy.dispose();
});

test('m9d901 delta em registro reconciliado volta para migrado', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const person = valid();
  legacy.fake.event('7', 'I', 1, person);
  await env.run(A(), { sourceSystem: legacy.system });
  const [migrated] = await env.recordsOf(legacy.system);
  assert.equal(migrated.state, 'MIGRATED');
  await env.q("UPDATE governance.mig_records SET state = 'RECONCILED' WHERE id = $1", [migrated.id]);
  legacy.fake.event('7', 'U', 2, { ...person, legalName: `${person.legalName} (alterado)` });
  await env.run(A(), { sourceSystem: legacy.system });
  const after1 = await env.stateOf(migrated.id);
  assert.deepEqual([after1.state, after1.source_version], ['MIGRATED', 2], 'exige nova reconciliação');
  const counts = (await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'))).totals;
  assert.deepEqual([counts.migrated, counts.reconciled], [1, 0]);
  legacy.dispose();
});

test('m9d901 delta em registro PENDING_REVIEW mantém o estado e anota a mudança', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const first = valid();
  legacy.fake.event('1', 'I', 1, first);
  legacy.fake.event('2', 'I', 2, { ...first, legalName: 'Outro cadastro, mesmo CPF' });
  await env.run(A(), { sourceSystem: legacy.system });
  const review = (await env.recordsOf(legacy.system)).find((r) => r.source_key === '2');
  assert.equal(review.state, 'PENDING_REVIEW');
  legacy.fake.event('2', 'U', 3, { ...first, legalName: 'Outro cadastro, nome corrigido' });
  await env.run(A(), { sourceSystem: legacy.system });
  const after2 = await env.stateOf(review.id);
  assert.equal(after2.state, 'PENDING_REVIEW');
  assert.equal(after2.source_version, review.source_version + 1);
  assert.match(after2.reason, /^Mudou na origem\./);
  assert.equal(after2.source_payload.legalName, 'Outro cadastro, nome corrigido');
  legacy.dispose();
});

test('m9d901 quarentena abre blocker', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  legacy.fake.event('9', 'I', 1, valid({ legalName: '' }));
  await env.run(A(), { sourceSystem: legacy.system });
  const [bad] = await env.recordsOf(legacy.system);
  assert.equal(bad.state, 'QUARANTINED');
  const tower = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  const blocker = tower.blockers.find((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN');
  assert.ok(blocker, 'quarentena abre blocker');
  assert.equal(blocker.entity, 'PERSON');
  assert.equal(blocker.detail.count, 1);
  assert.ok(blocker.since, 'gravado com o instante em que abriu');
  assert.equal((await env.openBlockers(A(), 'GOV_MIG_QUARANTINE_OPEN')).filter((b) => b.entity === 'PERSON' && b.ref === legacy.system).length, 1);
  await env.q("UPDATE governance.mig_records SET state = 'EXCLUDED' WHERE id = $1", [bad.id]);
  const after = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  assert.ok(!after.blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN'), 'o blocker fecha quando não há mais quarentena');
  legacy.dispose();
});

test('m9d901 delta em registro EXCLUDED é ignorado e registrado como ignorado', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  legacy.fake.event('9', 'I', 1, valid({ legalName: '' }));
  await env.run(A(), { sourceSystem: legacy.system });
  const [bad] = await env.recordsOf(legacy.system);
  await env.q("UPDATE governance.mig_records SET state = 'EXCLUDED' WHERE id = $1", [bad.id]);
  legacy.fake.event('9', 'U', 2, valid());
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  const ignored = await env.stateOf(bad.id);
  assert.deepEqual([ignored.state, ignored.source_version], ['EXCLUDED', bad.source_version], 'excluído é final');
  assert.equal(result.sources[0].totals.ignored, 1, 'o delta ignorado fica registrado no resumo da execução');
  legacy.dispose();
});
