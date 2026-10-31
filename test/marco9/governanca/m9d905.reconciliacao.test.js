'use strict';

// M9-D905 x M9-D901 — a verificação do lote é quem leva MIGRATED a RECONCILED e os divergentes à quarentena; blockers da Torre e job. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d905Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;

test('m9d905 lote VERIFIED promove seus registros MIGRATED a RECONCILED e reconciled sobe', { skip: skip() }, async () => {
  const { legacy, batch } = await env.appliedPersons(A(), 5);
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const before1 = await env.getTower(A(), runId);
  assert.deepEqual([before1.totals.migrated, before1.totals.reconciled], [5, 0]);
  assert.ok(before1.blockers.some((b) => b.code === 'GOV_MIG_RECONCILIATION_PENDING'), 'a diferença aparece desde o início');
  const result = await env.verify(A(), batch.id);
  assert.equal(result.promoted, 5);
  assert.deepEqual(await env.stateCounts(legacy.system), { RECONCILED: 5 });
  const after1 = await env.getTower(A(), runId);
  assert.deepEqual([after1.totals.migrated, after1.totals.reconciled], [5, 5]);
  assert.ok(!after1.blockers.some((b) => ['GOV_MIG_RECONCILIATION_PENDING', 'GOV_MIG_BATCH_UNVERIFIED'].includes(b.code)), 'tudo verificado: os blockers saem');
  assert.equal(after1.invariants.ok, true);
  legacy.dispose();
});

test('m9d905 sem conferência o registro permanece MIGRATED e lote HASH_MISMATCH leva só as linhas divergentes à quarentena', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 6);
  assert.deepEqual(await env.stateCounts(legacy.system), { MIGRATED: 6 }, 'o apply sozinho nunca reconcilia');
  await env.q("UPDATE people.persons SET legal_name = 'Nome trocado no destino' WHERE id = ANY($1::uuid[])", [[records[1].target_entity_id, records[3].target_entity_id]]);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'HASH_MISMATCH');
  assert.deepEqual([result.promoted, result.quarantined], [0, 2]);
  assert.deepEqual(await env.stateCounts(legacy.system), { MIGRATED: 4, QUARANTINED: 2 }, 'os demais continuam MIGRATED, sem virar RECONCILED');
  const bad = await env.q("SELECT source_key, reason FROM governance.mig_records WHERE source_system = $1 AND state = 'QUARANTINED' ORDER BY source_key", [legacy.system]);
  assert.deepEqual(bad.map((r) => r.source_key), [records[1].source_key, records[3].source_key].sort());
  assert.ok(bad.every((r) => /reconciliação falhou/i.test(r.reason)));
  const tower = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  const codes = tower.blockers.map((b) => b.code);
  assert.ok(codes.includes('GOV_MIG_HASH_MISMATCH') && codes.includes('GOV_MIG_QUARANTINE_OPEN'));
  assert.equal(tower.blockers.find((b) => b.code === 'GOV_MIG_HASH_MISMATCH').detail.count, 1);
  legacy.dispose();
});

test('m9d905 lote não verificado vira blocker', { skip: skip() }, async () => {
  const { legacy, batch } = await env.appliedPersons(A(), 3);
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const open = await env.getTower(A(), runId);
  const blocker = open.blockers.find((b) => b.code === 'GOV_MIG_BATCH_UNVERIFIED');
  assert.ok(blocker, 'há lotes sem verificação de integridade');
  assert.deepEqual([blocker.entity, blocker.detail.count, blocker.detail.batch_ids], ['PERSON', 1, [batch.id]]);
  await env.verify(A(), batch.id);
  assert.ok(!(await env.getTower(A(), runId)).blockers.some((b) => b.code === 'GOV_MIG_BATCH_UNVERIFIED'), 'verificado: o blocker fecha');
  legacy.dispose();
});

test('m9d905 o job verifica os lotes APPLIED de todas as fontes da empresa', { skip: skip() }, async () => {
  const one = await env.appliedPersons(A(), 2);
  const two = await env.appliedProperties(A(), 2);
  const done = await env.verifyPending(A());
  const ids = done.map((d) => d.batchId);
  assert.ok(ids.includes(one.batch.id) && ids.includes(two.batch.id));
  assert.equal((await env.batchRow(one.batch.id)).status, 'VERIFIED');
  assert.equal((await env.batchRow(two.batch.id)).status, 'VERIFIED');
  assert.deepEqual((await env.verifyPending(A())).filter((d) => [one.batch.id, two.batch.id].includes(d.batchId)), [], 'repetir não refaz o que já foi verificado');
  one.legacy.dispose(); two.legacy.dispose();
});

test('m9d905 replay dá o mesmo resultado: mesma raiz, verificação idempotente e nenhuma linha promovida duas vezes', { skip: skip() }, async () => {
  const { legacy, batch } = await env.appliedPersons(A(), 4);
  await env.verify(A(), batch.id);
  const { replayBatch } = require('../../../src/features/migration-v2/ingest/replay');
  const replay = await replayBatch(A(), { userId: A().userId }, batch.id);
  assert.equal(replay.batch.root_hash, batch.root_hash, 'a raiz do replay é a do original');
  const result = await env.verify(A(), replay.batch.id);
  assert.deepEqual([result.status, result.promoted], ['VERIFIED', 0], 'os registros já estavam RECONCILED');
  assert.deepEqual(await env.stateCounts(legacy.system), { RECONCILED: 4 });
  legacy.dispose();
});
