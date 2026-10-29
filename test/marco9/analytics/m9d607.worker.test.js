'use strict';

// M9-D607 — worker de read models: consumo idempotente por sourceEventId, estado (não delta) e sourceSnapshotAt/refreshedAt.
// Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env607 = require('../_helpers/m9d607Env');
const readModels = require('../../../src/features/analytics/read-models');

const { inTx, addSource, makeEvent, readRow, appliedCount } = env607;
let env;

before(async () => { env = await env607.setup(); });
after(() => env607.teardown(env));

const inA = (fn, opts) => inTx(env.tenantA, opts || {}, fn);
const inB = (fn, opts) => inTx(env.tenantB, opts || {}, fn);
const account = () => `conta-${env607.sfx()}`;
const balanceOf = async (tx, acc) => {
  const [[row]] = await tx.sequelize.query(`SELECT balance::text AS balance, refreshed_at FROM analytics.${env.model} WHERE account_id = :a`, { replacements: { a: acc }, transaction: tx });
  return row;
};

test('m9d607 read model duplicado por evento replay é idempotente', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '119000.00');
  await addSource(env, env.tenantA, acc, '1000.00');
  const event = makeEvent(env, env.tenantA, acc);
  await inA(async (tx) => {
    const first = await readModels.applyEvent(event, tx);
    assert.deepEqual([first.upserted, first.replayIgnored], [1, 0]);
    const before1 = await balanceOf(tx, acc);
    const second = await readModels.applyEvent(event, tx);
    assert.deepEqual([second.upserted, second.replayIgnored], [0, 1], 'a segunda entrega cai no passo 3 (replay_ignored=1)');
    assert.equal(before1.balance, '120000.00', 'valor lido do estado da fonte: 119.000 + 1.000');
    assert.deepEqual(await balanceOf(tx, acc), before1, 'nada mudou na segunda entrega, nem refreshed_at');
  });
});

test('m9d607 replay concorrente em 2 conexões aplica uma vez', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '1000.00');
  const event = makeEvent(env, env.tenantA, acc);
  const results = await Promise.all([inA((tx) => readModels.applyEvent(event, tx), { commit: true }), inA((tx) => readModels.applyEvent(event, tx), { commit: true })]);
  assert.deepEqual(results.map((r) => r.upserted).sort(), [0, 1]);
  assert.deepEqual(results.map((r) => r.replayIgnored).sort(), [0, 1]);
  assert.equal((await readRow(env, env.tenantA, acc)).balance, '1000.00', 'não dobrou');
  const [[n]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m AND source_event_id = :e', { replacements: { m: env.model, e: event.id } });
  assert.equal(n.n, 1);
});

test('m9d607 evento fora de ordem converge para o mesmo resultado', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '500.00');
  await addSource(env, env.tenantA, acc, '250.50');
  const created = makeEvent(env, env.tenantA, acc, { occurredAt: new Date('2026-10-28T10:00:00Z') });
  const settled = makeEvent(env, env.tenantA, acc, { occurredAt: new Date('2026-10-28T11:00:00Z') });
  const outcome = async (order) => inA(async (tx) => {
    for (const e of order) await readModels.applyEvent({ ...e, id: crypto.randomUUID() }, tx);
    const [[row]] = await tx.sequelize.query(`SELECT balance::text AS balance, source_snapshot_at FROM analytics.${env.model} WHERE account_id = :a`, { replacements: { a: acc }, transaction: tx });
    return row;
  });
  const inOrder = await outcome([created, settled]);
  const reversed = await outcome([settled, created]);
  assert.equal(inOrder.balance, '750.50');
  assert.equal(reversed.balance, inOrder.balance, 'estado, não delta: a ordem não muda o resultado');
  assert.equal(new Date(reversed.source_snapshot_at).toISOString(), '2026-10-28T11:00:00.000Z', 'source_snapshot_at nunca volta no tempo');
});

test('m9d607 erro após registrar evento aplicado desfaz tudo', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '10.00');
  const event = makeEvent(env, env.tenantA, acc);
  await inA(async (tx) => {
    env.failAccounts.add(acc);
    await assert.rejects(readModels.applyEvent(event, tx), (e) => e.code === 'M9D607_FONTE');
    const [[reg]] = await tx.sequelize.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE read_model = :m AND source_event_id = :e', { replacements: { m: env.model, e: event.id }, transaction: tx });
    assert.equal(reg.n, 0, 'o evento não ficou marcado como aplicado');
    env.failAccounts.delete(acc);
    const retry = await readModels.applyEvent(event, tx);
    assert.equal(retry.upserted, 1, 'reprocessar aplica corretamente');
  });
});

test('m9d607 source_snapshot_at e refreshed_at gravados', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '42.00');
  const occurredAt = new Date('2026-10-20T09:30:00Z');
  const t0 = Date.now();
  await inA(async (tx) => {
    await readModels.applyEvent(makeEvent(env, env.tenantA, acc, { occurredAt }), tx);
    const [[row]] = await tx.sequelize.query(`SELECT source_snapshot_at, refreshed_at, version FROM analytics.${env.model} WHERE account_id = :a`, { replacements: { a: acc }, transaction: tx });
    assert.equal(new Date(row.source_snapshot_at).toISOString(), occurredAt.toISOString());
    assert.ok(new Date(row.refreshed_at).getTime() >= t0 - 1000, 'refreshed_at é o momento da gravação');
    assert.equal(row.version, 3, 'version = versão do esquema do read model');
    assert.deepEqual(await readModels.assertReadModelTable(env.def, tx), [], 'a tabela tem as colunas comuns e o índice único');
  });
});

test('m9d607 evento de outra empresa não toca o read model da empresa A', async () => {
  const acc = account();
  await addSource(env, env.tenantA, acc, '100.00');
  await addSource(env, env.tenantB, acc, '7.00');
  const countA = await appliedCount(env, env.tenantA);
  await inB((tx) => readModels.applyEvent(makeEvent(env, env.tenantB, acc), tx), { commit: true });
  assert.equal(await readRow(env, env.tenantA, acc), null, 'a empresa A não ganhou linha');
  assert.equal((await readRow(env, env.tenantB, acc)).balance, '7.00');
  assert.equal(await appliedCount(env, env.tenantA), countA, 'controle da empresa A intacto');
  await inA(async (tx) => {
    const [rows] = await tx.sequelize.query('SELECT 1 FROM analytics.rm_applied_events WHERE company_id = :c', { replacements: { c: env.tenantB.companyId }, transaction: tx });
    assert.equal(rows.length, 0, 'com o contexto da empresa A, o controle da B é invisível (RLS FORCE)');
  });
});

test('m9d607 evento desconhecido é ignorado sem derrubar o worker', async () => {
  await inA(async (tx) => {
    const unknown = await readModels.applyEvent({ ...makeEvent(env, env.tenantA, account()), eventType: 'm9d607.tipo.que.ninguem.registrou' }, tx);
    assert.equal(unknown.ignored, 'UNKNOWN_EVENT');
    const noKey = await readModels.applyEvent({ ...makeEvent(env, env.tenantA, account()), payloadJson: {} }, tx);
    assert.equal(noKey.skipped, 1, 'evento sem chave de agregado não interessa a este read model');
    const orphan = await readModels.applyEvent({ ...makeEvent(env, env.tenantA, account()), companyId: crypto.randomUUID() }, tx);
    assert.equal(orphan.ignored, 'ORPHAN_COMPANY', 'empresa inexistente: ignorado e registrado, sem derrubar');
    const ok = await readModels.applyEvent(makeEvent(env, env.tenantA, account()), tx);
    assert.equal(ok.upserted, 1, 'o worker segue funcionando');
  });
});

test('m9d607 consulta a read model sem dado devolve INCOMPLETE e nunca zero', async () => {
  await inA(async (tx) => {
    const empty = await readModels.readAggregate(env.def, { companyId: env.tenantA.companyId, key: { account_id: 'conta-que-nao-existe' } }, tx);
    assert.deepEqual([empty.status, empty.code, empty.data], ['INCOMPLETE', 'ANALYTICS_READ_MODEL_EMPTY', null]);
    assert.equal(empty.message, 'Ainda não há dados para este indicador.');
  });
});
