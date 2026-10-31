'use strict';

// M9-D900 — modo CDC: carga em ordem, replay idempotente (mesmo estado e hash), exclusão lógica, lacuna de posição e replay como novo lote. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { replayBatch } = require('../../../src/features/migration-v2/ingest/replay');
const { runBatch, loadSettings } = require('../../../src/features/migration-v2/ingest/batch.runner');
const { assertMode } = require('../../../src/features/migration-v2/ingest/modes');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const actor = () => ({ userId: A().userId });

/** Origem CDC com `n` inserções (posições 1001...) e `u` atualizações no fim. */
async function seeded(n, u = 0) {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  for (let i = 0; i < n; i += 1) legacy.fake.event(`${i + 1}`, 'I', 1001 + i, env.personRecord());
  for (let i = 0; i < u; i += 1) legacy.fake.event(`${i + 1}`, 'U', 1001 + n + i, env.personRecord({ legalName: `QA-M9 Atualizado ${i}` }));
  return legacy;
}
const snapshot = async (system) => (await env.recordsOf(system)).map((r) => [r.source_key, r.state, r.row_hash, r.target_entity_id, r.source_version, r.source_deleted]);
const personCount = async (system) => (await env.q("SELECT count(*)::int AS n FROM core.external_refs WHERE source_system = $1 AND valid_to IS NULL", [system]))[0].n;

test('m9d900 CDC replay produz o mesmo estado e o mesmo hash', { skip: skip() }, async () => {
  const legacy = await seeded(50, 5);
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.status, 'SUCCEEDED');
  const [original] = await env.batchesOf(legacy.system);
  assert.deepEqual([original.status, original.row_count, original.from_token, original.to_token], ['APPLIED', 55, null, '1055']);
  assert.match(original.root_hash, /^[0-9a-f]{64}$/);
  const before = await snapshot(legacy.system);
  assert.equal(before.length, 50);
  assert.ok(before.every((r) => r[1] === 'MIGRATED'));
  assert.equal(before[0][4], 2, 'a atualização subiu a versão de origem');
  const replay = await replayBatch(A(), actor(), original.id);
  assert.equal(replay.batch.root_hash, original.root_hash, 'mesmo hash');
  assert.deepEqual(await snapshot(legacy.system), before, 'mesmo estado');
  assert.equal(replay.counts.skipped, 55, 'nada foi reaplicado');
  assert.equal((await legacy.source()).checkpoint_token, '1055', 'replay não mexe no checkpoint');
  legacy.dispose();
});

test('m9d900 replay não duplica linhas nem chaves de idempotência', { skip: skip() }, async () => {
  const legacy = await seeded(20);
  await env.run(A(), { sourceSystem: legacy.system });
  const [original] = await env.batchesOf(legacy.system);
  const keys = (await env.keysOf(legacy.system)).length;
  const refs = await personCount(legacy.system);
  const persons = (await env.q('SELECT count(*)::int AS n FROM people.persons p JOIN core.external_refs r ON r.entity_id = p.id WHERE r.source_system = $1', [legacy.system]))[0].n;
  await replayBatch(A(), actor(), original.id);
  await replayBatch(A(), actor(), original.id);
  assert.equal((await env.keysOf(legacy.system)).length, keys, 'zero chaves de idempotência novas');
  assert.equal(keys, 20);
  assert.equal(await personCount(legacy.system), refs, 'nenhuma referência nova');
  assert.equal((await env.q('SELECT count(*)::int AS n FROM people.persons p JOIN core.external_refs r ON r.entity_id = p.id WHERE r.source_system = $1', [legacy.system]))[0].n, persons);
  assert.equal((await env.recordsOf(legacy.system)).length, 20);
  legacy.dispose();
});

test('m9d900 replay cria novo lote com replay_of e não muda o lote original', { skip: skip() }, async () => {
  const legacy = await seeded(8);
  await env.run(A(), { sourceSystem: legacy.system });
  const [original] = await env.batchesOf(legacy.system);
  const { batch } = await replayBatch(A(), actor(), original.id);
  assert.notEqual(batch.id, original.id);
  assert.deepEqual([batch.replay_of, batch.status], [original.id, 'APPLIED']);
  const [after] = (await env.batchesOf(legacy.system)).filter((b) => b.id === original.id);
  assert.deepEqual([after.status, after.root_hash, after.finished_at, after.updated_at], [original.status, original.root_hash, original.finished_at, original.updated_at]);
  assert.equal((await env.batchesOf(legacy.system)).length, 2);
  const audit = await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'migration.batch.applied' AND entity_id = ANY($1::uuid[])", [[original.id, batch.id]]);
  assert.equal(audit[0].n, 2, 'cada lote aplicado grava migration.batch.applied');
  legacy.dispose();
});

test('m9d900 delete vira exclusão lógica', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  legacy.fake.event('77', 'I', 1, env.personRecord());
  legacy.fake.event('78', 'I', 2, env.personRecord());
  legacy.fake.event('77', 'D', 3);
  legacy.fake.event('999', 'D', 4);
  await env.run(A(), { sourceSystem: legacy.system });
  const records = Object.fromEntries((await env.recordsOf(legacy.system)).map((r) => [r.source_key, r]));
  assert.equal(records['77'].source_deleted, true);
  assert.equal(records['78'].source_deleted, false);
  const [person] = await env.q('SELECT p.source_deleted, p.source_deleted_at, p.legal_name FROM people.persons p WHERE p.id = $1', [records['77'].target_entity_id]);
  assert.equal(person.source_deleted, true, 'o destino fica marcado');
  assert.ok(person.legal_name, 'e a linha continua lá: exclusão nunca é física');
  assert.deepEqual([records['999'].state, records['999'].source_deleted], ['EXCLUDED', true], 'chave que nunca existiu no destino: nada a apagar');
  legacy.dispose();
});

test('m9d900 posição com lacuna é recusada', { skip: skip() }, async () => {
  const legacy = await seeded(5);
  await env.run(A(), { sourceSystem: legacy.system });
  const source = await legacy.source();
  assert.equal(source.checkpoint_token, '1005');
  const settings = await loadSettings(A());
  const gap = { fromToken: '1100', toToken: '1101', events: [{ sourceKey: '9', op: 'I', position: '1101', record: env.personRecord() }] };
  const err = await runBatch(A(), actor(), (await env.batchesOf(legacy.system))[0].run_id, source, gap, { settings }).then(() => null, (e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [409, 'GOV_MIG_POSITION_GAP', 'O lote começa depois do último checkpoint: há eventos faltando.']);
  assert.equal((await env.batchesOf(legacy.system)).length, 1, 'nenhum lote nasceu');
  assert.equal((await legacy.source()).checkpoint_token, '1005');
  // eventos fora de ordem vindos da origem também são recusados e nada é aplicado
  const bad = await env.installSource(A(), { mode: 'CDC' });
  bad.fake.state.keepOrder = true;
  bad.fake.event('1', 'I', 10, env.personRecord());
  bad.fake.event('2', 'I', 9, env.personRecord());
  const { result } = await env.run(A(), { sourceSystem: bad.system });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.sources[0].error.code, 'GOV_MIG_POSITION_GAP');
  assert.equal((await env.recordsOf(bad.system)).length, 0);
  legacy.dispose(); bad.dispose();
});

test('m9d900 a lacuna também é barrada dentro da transação do lote (corrida entre executores)', { skip: skip() }, async () => {
  const legacy = await seeded(3);
  await env.run(A(), { sourceSystem: legacy.system });
  const source = await legacy.source();
  const [first] = await env.batchesOf(legacy.system);
  const batchRepository = require('../../../src/features/migration-v2/ingest/batch.repository');
  const { applyBatch } = require('../../../src/features/migration-v2/ingest/applier');
  const err = await env.openTenantTx(A(), async (tx) => {
    const planned = await batchRepository.insert(A(), { runId: first.run_id, source, fromToken: '5000', toToken: '5001' }, tx);
    const running = await batchRepository.transition(A(), planned.id, 'RUNNING', {}, tx);
    return applyBatch(A(), actor(), running, [{ sourceKey: 'x', op: 'I', position: '5001', record: env.personRecord() }], tx);
  }).then(() => null, (e) => e);
  assert.equal(err.code, 'GOV_MIG_POSITION_GAP');
  assert.equal((await env.recordsOf(legacy.system)).length, 3);
  legacy.dispose();
});

test('m9d900 replay de um lote antigo não faz o checkpoint recuar', { skip: skip() }, async () => {
  const legacy = await seeded(4);
  await env.run(A(), { sourceSystem: legacy.system });
  legacy.fake.event('50', 'I', 3000, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  const [first] = await env.batchesOf(legacy.system);
  await replayBatch(A(), actor(), first.id);
  assert.equal((await legacy.source()).checkpoint_token, '3000');
  legacy.dispose();
});

test('m9d900 fonte sem modo válido devolve GOV_MIG_SOURCE_MODE_INVALID', () => {
  const err = (() => { try { assertMode('STREAM'); return null; } catch (e) { return e; } })();
  assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_MIG_SOURCE_MODE_INVALID', 'Informe CDC ou watermark para esta fonte.']);
  assert.equal(assertMode('FULL_DIFF'), 'FULL_DIFF');
});

test('m9d900 carga inicial seguida de três deltas aplicados em ordem', { skip: skip() }, async () => {
  const legacy = await seeded(30);
  await env.run(A(), { sourceSystem: legacy.system });
  for (let delta = 1; delta <= 3; delta += 1) {
    for (let i = 0; i < 4; i += 1) legacy.fake.event(`${delta * 100 + i}`, 'I', 2000 + delta * 10 + i, env.personRecord());
    legacy.fake.event(`${delta}`, 'U', 2000 + delta * 10 + 5, env.personRecord({ legalName: `QA-M9 Delta ${delta}` }));
     
    await env.run(A(), { sourceSystem: legacy.system });
  }
  const batches = await env.batchesOf(legacy.system);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.map((b) => b.status), ['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
  assert.equal((await legacy.source()).checkpoint_token, '2035');
  assert.equal((await env.recordsOf(legacy.system)).length, 42);
  const rerun = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(rerun.result.sources[0].batches, 0, 'reexecutar o mesmo delta não muda nada');
  legacy.dispose();
});
