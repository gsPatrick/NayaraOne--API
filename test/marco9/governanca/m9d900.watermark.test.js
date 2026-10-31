'use strict';

// M9-D900 — modos WATERMARK e FULL_DIFF: sobreposição que captura commit tardio, exclusão na origem por comparação de chaves, quarentena que não derruba o lote,
// conector SQL real e isolamento entre empresas. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const sqlConnector = require('../../../src/features/migration-v2/ingest/connectors/sql.connector');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const setSetting = (tenant, key, value) => env.openTenantTx(tenant, (tx) => upsertSetting(key, value, tenant, tenant.userId, tx));

test('m9d900 watermark com sobreposição captura commit tardio', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'WATERMARK' });
  legacy.fake.row('5000', '2026-10-27T02:00:00.000Z', env.personRecord());
  legacy.fake.row('4999', '2026-10-27T01:30:00.000Z', env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  assert.equal((await legacy.source()).checkpoint_token, '2026-10-27T02:00:00.000000Z|5000');
  // linha com updated_at 01:59:30 que só chegou depois do checkpoint (commit tardio, dentro dos 120 s)
  legacy.fake.row('4000', '2026-10-27T01:59:30.000Z', env.personRecord());
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.sources[0].totals.migrated, 1, 'só a linha tardia é nova; as relidas são descartadas');
  assert.ok(result.sources[0].totals.skipped >= 1, 'as linhas já aplicadas voltaram na sobreposição e foram ignoradas');
  const states = Object.fromEntries((await env.recordsOf(legacy.system)).map((r) => [r.source_key, r.state]));
  assert.deepEqual(states, { 4000: 'MIGRATED', 4999: 'MIGRATED', 5000: 'MIGRATED' });
  assert.equal((await legacy.source()).checkpoint_token, '2026-10-27T02:00:00.000000Z|5000', 'o checkpoint não recua');
  // com a sobreposição zerada pelo administrador a mesma situação perde a linha: o parâmetro é lido de verdade
  await setSetting(A(), 'migracao.watermark.sobreposicao_s', 0);
  legacy.fake.row('3999', '2026-10-27T01:59:45.000Z', env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  assert.equal((await env.recordsOf(legacy.system)).some((r) => r.source_key === '3999'), false);
  await setSetting(A(), 'migracao.watermark.sobreposicao_s', 120);
  await env.run(A(), { sourceSystem: legacy.system });
  assert.equal((await env.recordsOf(legacy.system)).some((r) => r.source_key === '3999'), true, 'com 120 s a linha é capturada');
  legacy.dispose();
});

test('m9d900 WATERMARK marca como source_deleted a chave ausente na comparação da última carga', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'WATERMARK' });
  for (let i = 1; i <= 4; i += 1) legacy.fake.row(`${i}`, `2026-10-27T01:0${i}:00.000Z`, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  legacy.fake.drop('3');
  const normal = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(normal.result.sources[0].deletedBySource, 0, 'o watermark sozinho não enxerga exclusão');
  assert.equal((await env.recordsOf(legacy.system)).filter((r) => r.source_deleted).length, 0);
  const last = await env.run(A(), { sourceSystem: legacy.system, lastDelta: true });
  assert.equal(last.result.sources[0].deletedBySource, 1);
  const rows = await env.recordsOf(legacy.system);
  assert.deepEqual(rows.filter((r) => r.source_deleted).map((r) => r.source_key), ['3']);
  const [person] = await env.q('SELECT source_deleted FROM people.persons WHERE id = $1', [rows.find((r) => r.source_key === '3').target_entity_id]);
  assert.equal(person.source_deleted, true);
  const again = await env.run(A(), { sourceSystem: legacy.system, lastDelta: true });
  assert.equal(again.result.sources[0].deletedBySource, 0, 'a chave já marcada não é marcada de novo');
  legacy.dispose();
});

test('m9d900 FULL_DIFF aplica só o que mudou e marca as chaves ausentes em toda execução', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'FULL_DIFF' });
  const base = { 1: env.personRecord(), 2: env.personRecord(), 3: env.personRecord() };
  for (const [key, record] of Object.entries(base)) legacy.fake.row(key, '2026-10-27T01:00:00.000Z', record);
  const first = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(first.result.sources[0].totals.migrated, 3);
  legacy.fake.row('2', '2026-10-27T01:00:00.000Z', { ...base[2], legalName: 'QA-M9 Mudou' });
  legacy.fake.drop('3');
  const second = await env.run(A(), { sourceSystem: legacy.system });
  assert.deepEqual([second.result.sources[0].totals.migrated, second.result.sources[0].totals.skipped, second.result.sources[0].deletedBySource], [1, 1, 1]);
  const rows = Object.fromEntries((await env.recordsOf(legacy.system)).map((r) => [r.source_key, r]));
  assert.deepEqual([rows['2'].source_version, rows['3'].source_deleted, rows['1'].source_deleted], [2, true, false]);
  assert.equal((await legacy.source()).checkpoint_token, null, 'FULL_DIFF não tem checkpoint');
  legacy.dispose();
});

test('m9d900 linha inválida vai para quarentena e o lote segue; possível duplicata vai para revisão', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  const dup = env.personRecord();
  legacy.fake.event('1', 'I', 1, env.personRecord());
  legacy.fake.event('2', 'I', 2, { legalName: 'QA-M9 CPF ruim', personType: 'PF', taxId: '11111111111' });
  legacy.fake.event('3', 'I', 3, env.personRecord());
  legacy.fake.event('4', 'I', 4, dup);
  legacy.fake.event('5', 'I', 5, { ...dup, legalName: 'QA-M9 Outro cadastro mesmo CPF' });
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.status, 'SUCCEEDED');
  const rows = Object.fromEntries((await env.recordsOf(legacy.system)).map((r) => [r.source_key, r]));
  assert.deepEqual([rows['1'].state, rows['2'].state, rows['3'].state, rows['4'].state, rows['5'].state], ['MIGRATED', 'QUARANTINED', 'MIGRATED', 'MIGRATED', 'PENDING_REVIEW']);
  assert.match(rows['2'].reason, /CPF/);
  assert.equal(rows['2'].target_entity_id, null, 'a linha inválida não chega ao destino');
  assert.equal((await env.batchesOf(legacy.system))[0].status, 'APPLIED');
  // QUARANTINED mantém o estado quando a origem muda: só atualiza o conteúdo e a versão (M9-D901 §3.1)
  legacy.fake.event('2', 'U', 6, { legalName: 'QA-M9 CPF ruim', personType: 'PF', taxId: '22222222222' });
  await env.run(A(), { sourceSystem: legacy.system });
  const changed = (await env.recordsOf(legacy.system)).find((r) => r.source_key === '2');
  assert.deepEqual([changed.state, changed.source_version], ['QUARANTINED', 2]);
  legacy.dispose();
});

test('m9d900 todo registro migrado tem a referência do ID legado vigente (M9-D906)', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC', entity: 'PERSON' });
  for (let i = 1; i <= 6; i += 1) legacy.fake.event(`0000${i}`, 'I', i, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  const rows = await env.q(`SELECT r.source_key, r.target_entity_id, x.entity_id, x.valid_to, x.migration_run_id FROM governance.mig_records r
    LEFT JOIN core.external_refs x ON x.company_id = r.company_id AND x.source_system = r.source_system AND x.entity_type = r.entity AND x.source_key = r.source_key AND x.valid_to IS NULL
    WHERE r.source_system = $1 AND r.state = 'MIGRATED'`, [legacy.system]);
  assert.equal(rows.length, 6);
  for (const row of rows) assert.deepEqual([row.entity_id, row.valid_to === null, Boolean(row.migration_run_id)], [row.target_entity_id, true, true], `chave ${row.source_key} (zero à esquerda preservado)`);
  legacy.dispose();
});

test('m9d900 isolamento entre empresas de destino', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  legacy.fake.event('1', 'I', 1, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  const seen = await env.withRollbackTenantTransaction(tenants.B, async (tx) => ({
    sources: await env.query('SELECT count(*)::int AS n FROM governance.mig_sources WHERE source_system = :s', { s: legacy.system }, tx),
    batches: await env.query('SELECT count(*)::int AS n FROM governance.mig_batches WHERE source_system = :s', { s: legacy.system }, tx),
    records: await env.query('SELECT count(*)::int AS n FROM governance.mig_records WHERE source_system = :s', { s: legacy.system }, tx),
    keys: await env.query('SELECT count(*)::int AS n FROM governance.mig_event_keys WHERE idempotency_key LIKE :s', { s: `${legacy.system}:%` }, tx),
    runs: await env.query('SELECT count(*)::int AS n FROM governance.mig_runs WHERE source_system = :s', { s: legacy.system }, tx),
  }));
  for (const [table, rows] of Object.entries(seen)) assert.equal(rows[0].n, 0, `a empresa B não vê ${table} da A`);
  const bad = await env.withRollbackTenantTransaction(tenants.B, (tx) => env.dbError(tx,
    "INSERT INTO governance.mig_runs (group_id, company_id) VALUES (:g, :c)", { g: tenants.A.groupId, c: tenants.A.companyId }));
  assert.match(String(bad), /row-level security|violates/i);
  legacy.dispose();
});

test('m9d900 conector SQL lê o legado por uma conexão somente leitura', { skip: skip() }, async () => {
  const schema = `legado_${env.suffix()}`.toLowerCase().slice(0, 40);
  await env.adminQuery(`CREATE SCHEMA ${schema}`);
  await env.adminQuery(`CREATE TABLE ${schema}.clientes (id integer PRIMARY KEY, legal_name text, tax_id text, person_type text, updated_at timestamptz NOT NULL)`);
  await env.adminQuery(`INSERT INTO ${schema}.clientes VALUES (1, 'QA-M9 SQL Um', '${env.cpf()}', 'PF', '2026-10-27 01:00:00.123456+00'), (2, 'QA-M9 SQL Dois', '${env.cpf()}', 'PF', '2026-10-27 01:00:00.123456+00')`);
  await env.adminQuery(`CREATE TABLE ${schema}.log (seq bigint PRIMARY KEY, op text, id integer, legal_name text, tax_id text, person_type text)`);
  await env.adminQuery(`INSERT INTO ${schema}.log VALUES (11, 'I', 1, 'QA-M9 SQL Um', '${env.cpf()}', 'PF'), (12, 'D', 1, NULL, NULL, NULL)`);
  process.env.QA_M9_LEGACY_URL = process.env.DATABASE_ADMIN_URL;
  const config = { relation: `${schema}.clientes`, keyColumn: 'id', updatedAtColumn: 'updated_at', logRelation: `${schema}.log`, positionColumn: 'seq', opColumn: 'op' };
  const conn = await sqlConnector.createSqlConnector({ config, secret_ref: 'QA_M9_LEGACY_URL' });
  try {
    const rows = await conn.readRows({ afterTs: null, afterKey: '', limit: 10 });
    assert.deepEqual(rows.map((r) => [r.sourceKey, r.updatedAt]), [['1', '2026-10-27T01:00:00.123456Z'], ['2', '2026-10-27T01:00:00.123456Z']], 'microssegundos e desempate por chave');
    const after = await conn.readRows({ afterTs: '2026-10-27T01:00:00.123456Z', afterKey: '1', limit: 10 });
    assert.deepEqual(after.map((r) => r.sourceKey), ['2']);
    assert.deepEqual((await conn.readEvents({ after: '11', limit: 10 })).map((e) => [e.sourceKey, e.op, e.position]), [['1', 'D', '12']]);
    assert.deepEqual((await conn.readAllRows({ afterKey: '', limit: 10 })).map((r) => r.sourceKey), ['1', '2']);
    assert.deepEqual(await conn.listKeys(), ['1', '2']);
  } finally {
    await conn.close();
  }
  delete process.env.QA_M9_LEGACY_URL;
  await assert.rejects(sqlConnector.createSqlConnector({ config, secret_ref: 'QA_M9_VAZIA' }), (err) => err.code === 'GOV_MIG_SECRET_MISSING');
  await env.adminQuery(`DROP SCHEMA ${schema} CASCADE`);
});
