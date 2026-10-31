'use strict';

// M9-D905 — verificação do lote: a raiz Merkle da origem (o que foi lido) contra a do destino (relido do banco), contagem, folhas e máquina de estados. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d905Env');
const merkle = require('../../../src/features/migration-v2/integrity/merkle');
const canonical = require('../../../src/features/migration-v2/integrity/canonical');
const states = require('../../../src/features/migration-v2/ingest/batch.states');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const PERSON_FIELDS = [{ field: 'personType', type: 'text' }, { field: 'legalName', type: 'text' }, { field: 'preferredName', type: 'text' }, { field: 'taxId', type: 'text' }, { field: 'birthDate', type: 'date' }];

test('m9d905 batch checksum idêntico gera raízes iguais', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 6);
  assert.equal(batch.status, 'APPLIED');
  assert.match(batch.root_hash, /^[0-9a-f]{64}$/);
  // a raiz gravada no apply é a Merkle das linhas canônicas do que foi lido (calculada aqui de forma independente)
  const lines = records.map((r) => ({ key: r.source_key, line: canonical.canonicalLine(PERSON_FIELDS, { personType: 'PF', legalName: r.source_payload.legalName, preferredName: null, taxId: r.source_payload.taxId, birthDate: null }) }));
  assert.equal(batch.root_hash, merkle.rootOfLines(lines).root);
  assert.equal(batch.source_root, batch.root_hash);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'VERIFIED');
  const after1 = await env.batchRow(batch.id);
  assert.deepEqual([after1.status, after1.source_root, after1.target_root, after1.source_count, after1.target_count], ['VERIFIED', batch.root_hash, batch.root_hash, 6, 6]);
  assert.ok(after1.verified_at);
  assert.equal(String(after1.finished_at), String(batch.finished_at), 'verificar não muda o fim do lote (a vazão do ETA depende dele)');
  const audit = await env.q("SELECT after_json FROM audit.audit_log WHERE entity_id = $1 AND action = 'migration.batch.verified'", [batch.id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after_json.status, 'VERIFIED');
  legacy.dispose();
});

test('m9d905 alteração de 1 centavo muda a raiz e o lote vira HASH_MISMATCH', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedProperties(A(), 4);
  await env.q('UPDATE real_estate.properties SET area_total_m2 = area_total_m2 + 0.01 WHERE id = $1', [records[1].target_entity_id]);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'HASH_MISMATCH');
  const row = await env.batchRow(batch.id);
  assert.notEqual(row.source_root, row.target_root);
  assert.equal(row.status, 'HASH_MISMATCH');
  assert.match(row.error, /GOV_MIG_HASH_MISMATCH.*O conteúdo do lote no destino difere da origem\./);
  assert.deepEqual(result.divergent, [records[1].source_key]);
  legacy.dispose();
});

test('m9d905 linha perdida detectada', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 5);
  await env.q('DELETE FROM people.persons WHERE id = $1', [records[2].target_entity_id]);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'HASH_MISMATCH');
  const row = await env.batchRow(batch.id);
  assert.deepEqual([row.source_count, row.target_count], [5, 4], 'a contagem também difere');
  assert.deepEqual(result.divergent, [records[2].source_key]);
  legacy.dispose();
});

test('m9d905 perda de acento detectada', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 3);
  await env.q("UPDATE people.persons SET legal_name = replace(legal_name, 'João', 'Joao') WHERE id = $1", [records[0].target_entity_id]);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'HASH_MISMATCH');
  assert.deepEqual(result.divergent, [records[0].source_key]);
  legacy.dispose();
});

test('m9d905 destino é relido do banco, não da memória', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 3);
  // mexer no que a origem guardou depois do apply não muda a raiz da origem; mexer no destino muda a do destino
  await env.q("UPDATE governance.mig_records SET source_payload = jsonb_set(source_payload, '{legalName}', '\"outro nome\"') WHERE id = $1", [records[0].id]);
  const [leafBefore] = await env.leavesOf(batch.id);
  await env.q("UPDATE people.persons SET preferred_name = 'Apelido novo' WHERE id = $1", [records[1].target_entity_id]);
  const result = await env.verify(A(), batch.id);
  assert.equal(result.status, 'HASH_MISMATCH');
  assert.deepEqual(result.divergent, [records[1].source_key], 'só a linha realmente diferente no banco do destino');
  const row = await env.batchRow(batch.id);
  assert.equal(row.source_root, batch.source_root, 'a raiz da origem é a do que foi lido');
  assert.equal((await env.leavesOf(batch.id))[0].leaf_hash_source, leafBefore.leaf_hash_source);
  legacy.dispose();
});

test('m9d905 lote só vira VERIFIED com raízes e contagem iguais e HASH_MISMATCH não volta a VERIFIED sem reaplicação', { skip: skip() }, async () => {
  const { decide } = require('../../../src/features/migration-v2/integrity/batch.verify');
  assert.equal(decide({ sourceRoot: 'a', targetRoot: 'a', sourceCount: 3, targetCount: 3 }), 'VERIFIED');
  assert.equal(decide({ sourceRoot: 'a', targetRoot: 'a', sourceCount: 3, targetCount: 2 }), 'HASH_MISMATCH', 'contagem diferente reprova mesmo com raízes iguais');
  assert.equal(decide({ sourceRoot: 'a', targetRoot: 'b', sourceCount: 3, targetCount: 3 }), 'HASH_MISMATCH');
  assert.equal(states.canTransition('HASH_MISMATCH', 'VERIFIED'), false);
  const { legacy, batch, records } = await env.appliedPersons(A(), 3);
  await env.q("UPDATE people.persons SET legal_name = 'Adulterado' WHERE id = $1", [records[0].target_entity_id]);
  assert.equal((await env.verify(A(), batch.id)).status, 'HASH_MISMATCH');
  const err = await env.fail(env.verify(A(), batch.id));
  assert.deepEqual([err.statusCode, err.code], [409, 'GOV_MIG_BATCH_INVALID_TRANSITION']);
  assert.equal((await env.batchRow(batch.id)).status, 'HASH_MISMATCH', 'continua em HASH_MISMATCH mesmo após consertar o destino, até reaplicar');
  // reaplicação: HASH_MISMATCH -> RUNNING -> APPLIED pela máquina de estados do lote, e então a verificação passa
  const batches = require('../../../src/features/migration-v2/ingest/batch.repository');
  await env.openTenantTx(A(), (tx) => batches.transition(A(), batch.id, 'RUNNING', {}, tx));
  await env.openTenantTx(A(), (tx) => batches.transition(A(), batch.id, 'APPLIED', { rowCount: 3 }, tx));
  await env.q("UPDATE people.persons SET legal_name = $2 WHERE id = $1", [records[0].target_entity_id, records[0].source_payload.legalName]);
  assert.equal((await env.verify(A(), batch.id)).status, 'VERIFIED');
  const again = await env.verify(A(), batch.id);
  assert.deepEqual([again.status, again.already], ['VERIFIED', true], 'verificar de novo dá o mesmo resultado');
  legacy.dispose();
});

test('m9d905 folhas guardadas apontam as linhas divergentes', { skip: skip() }, async () => {
  const { legacy, batch, records } = await env.appliedPersons(A(), 5);
  const before = await env.leavesOf(batch.id);
  assert.equal(before.length, 5);
  assert.ok(before.every((leaf) => /^[0-9a-f]{64}$/.test(leaf.leaf_hash_source) && leaf.leaf_hash_target === null), 'antes da verificação só há o lado da origem');
  await env.q("UPDATE people.persons SET legal_name = 'X' WHERE id = ANY($1::uuid[])", [[records[0].target_entity_id, records[4].target_entity_id]]);
  await env.verify(A(), batch.id);
  const leaves = await env.leavesOf(batch.id);
  const diverging = leaves.filter((leaf) => leaf.leaf_hash_target !== leaf.leaf_hash_source).map((leaf) => leaf.source_key);
  assert.deepEqual(diverging, [records[0].source_key, records[4].source_key].sort());
  assert.ok(leaves.filter((leaf) => leaf.leaf_hash_target === leaf.leaf_hash_source).length === 3);
  legacy.dispose();
});

test('m9d905 esquema da entidade sem ordem de campos devolve 422 e a fonte para com o erro', { skip: skip() }, async () => {
  const schema = require('../../../src/features/migration-v2/integrity/schema.repository');
  const err = await env.fail(env.openTenantTx(A(), (tx) => schema.loadSchema(A(), 'CONTRACT', tx)));
  assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_MIG_SCHEMA_MISSING', 'Defina o esquema canônico da entidade.']);
  const person = await env.openTenantTx(A(), (tx) => schema.loadSchema(A(), 'PERSON', tx));
  assert.deepEqual(person.map((f) => f.field), ['personType', 'legalName', 'preferredName', 'taxId', 'birthDate']);
  const property = await env.openTenantTx(A(), (tx) => schema.loadSchema(A(), 'PROPERTY', tx));
  assert.equal(property.find((f) => f.field === 'areaTotalM2').scale, 6);
  const targets = require('../../../src/features/migration-v2/ingest/targets');
  const restore = targets.overrideTarget('CONTRACT', { entityType: 'CONTRACT', assess: async () => null, upsert: async () => env.randomUUID(), markDeleted: async () => null });
  const legacy = await env.installSource(A(), { entity: 'CONTRACT' });
  legacy.fake.event('1', 'I', 1, { x: 1 });
  const { result } = await env.run(A(), { sourceSystem: legacy.system, entity: 'CONTRACT' });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.sources[0].error.code, 'GOV_MIG_SCHEMA_MISSING');
  assert.equal((await env.batchesOf(legacy.system)).length, 0, 'nenhum lote é aberto sem esquema');
  restore(); legacy.dispose();
});
