'use strict';

// Marco 9, M9-D205 — integration.dispatches: idempotência, hash canônico, imutabilidade, RLS, retenção, worker.
// Roda em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, config, criar, forcar, ler, chave, dispatch } = require('./dispatchHelpers');
const { IntegrationDispatch } = require('../../../src/models');

let tenant;
let outro;
let con;
let con2;

before(async () => {
  ({ tenant, outro } = await carregarTenants());
  con = await conexao(tenant, 'BANK');
  con2 = await conexao(tenant, 'MESSAGING');
});
after(async () => { await sequelize.close(); });

test('dispatch_unique_idempotency_por_connection_operacao', async () => {
  const k = chave();
  const [a, b] = await Promise.all([criar(tenant, con.id, k), criar(tenant, con.id, k)]);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(a.dispatch.id, b.dispatch.id, 'o mesmo dispatch para as duas conexões simultâneas');
  const n = await comTenant(tenant, (t) => IntegrationDispatch.count({ where: { connectionId: con.id, operation: 'submitPayment', idempotencyKey: k }, transaction: t }));
  assert.equal(n, 1);
  const outraOp = await criar(tenant, con.id, k, { operation: 'getStatement' });
  const outraCon = await criar(tenant, con2.id, k);
  assert.ok(outraOp.created && outraCon.created, 'a chave é única por conexão E operação');
  assert.equal(a.dispatch.status, 'PENDING');
  assert.equal(a.dispatch.criticalityOp, 'DANGEROUS', 'sem informar, a operação é tratada como perigosa');
  await assert.rejects(criar(tenant, con.id, '  '), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED');
  await assert.rejects(criar(tenant, '00000000-0000-4000-8000-00000000d205', chave()), (e) => e.statusCode === 404);
});

test('dispatch_hash_json_canonico', async () => {
  const h1 = dispatch.hashPayload({ valor: '100.00', favorecido: 'X' });
  assert.equal(h1, dispatch.hashPayload({ favorecido: 'X', valor: '100.00' }), 'mesma entrada em ordem diferente, mesmo hash');
  assert.equal(dispatch.hashPayload({ a: { y: 2, x: [1, { c: 3, b: 2 }] } }), dispatch.hashPayload({ a: { x: [1, { b: 2, c: 3 }], y: 2 } }));
  assert.notEqual(dispatch.hashPayload({ a: [1, 2] }), dispatch.hashPayload({ a: [2, 1] }), 'a ordem de uma lista conta');
  assert.notEqual(h1, dispatch.hashPayload({ valor: '100.01', favorecido: 'X' }));
  assert.equal(dispatch.canonicalize({ b: 1, a: undefined, c: null }), '{"b":1,"c":null}');
  assert.equal(h1, crypto.createHash('sha256').update('{"favorecido":"X","valor":"100.00"}').digest('hex'));
  const { dispatch: d } = await criar(tenant, con.id, chave(), { snapshot: { valor: '100.00', favorecido: 'X' } });
  const lido = await ler(tenant, d.id);
  assert.equal(lido.payload_hash, h1, 'o hash gravado é o do JSON canônico');
  assert.deepEqual(lido.payload_snapshot, { valor: '100.00', favorecido: 'X' }, 'lido de volta idêntico');
});

test('dispatch_snapshot_imutavel', async () => {
  const { dispatch: d } = await criar(tenant, con.id, chave());
  const tenta = (set, rep = {}) => comTenant(tenant, (t) => sequelize.query(`UPDATE integration.dispatches SET ${set} WHERE id = :id`, { replacements: { id: d.id, ...rep }, transaction: t }));
  for (const [set, rep] of [
    ["payload_snapshot = '{\"valor\":\"999\"}'::jsonb", {}],
    ["payload_hash = repeat('a', 64)", {}],
    ["idempotency_key = 'outra'", {}],
    ["operation = 'outra'", {}],
    ['connection_id = :c', { c: con2.id }],
  ]) {
    await assert.rejects(tenta(set, rep), /INTEGRATION_DISPATCH_IMMUTABLE/, set);
  }
  await assert.rejects(tenta("payload_snapshot = '{\"valor\":\"999\"}'::jsonb").catch((e) => { throw dispatch.translateDispatchDbError(e); }), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_DISPATCH_IMMUTABLE');
  assert.deepEqual((await ler(tenant, d.id)).payload_snapshot, { valor: '100.00', favorecido: 'X' });
  await tenta("external_request_id = 'req-1'");
});

test('dispatch_rls_isolamento', async (t0) => {
  if (!outro) { t0.skip('sem a empresa B do seed'); return; }
  const { dispatch: d } = await criar(tenant, con.id, chave());
  assert.equal((await comTenant(outro, (t) => IntegrationDispatch.findAll({ where: { id: d.id }, transaction: t }))).length, 0);
  await assert.rejects(comTenant(outro, (t) => dispatch.createDispatch(ctxDe(outro), { connectionId: con.id, operation: 'x', idempotencyKey: chave(), snapshot: { a: 1 } }, t)), (e) => e.statusCode === 404, 'conexão de outra empresa não vale');
  await assert.rejects(comTenant(outro, (t) => sequelize.query(
    `INSERT INTO integration.dispatches (group_id, company_id, connection_id, provider_code, operation, payload_snapshot, payload_hash, idempotency_key, max_attempts)
     VALUES (:g, :c, :con, 'x', 'x', '{}'::jsonb, repeat('a', 64), :k, 3)`,
    { replacements: { g: tenant.groupId, c: tenant.companyId, con: con.id, k: chave() }, transaction: t }
  )), /row-level security/i);
});

test('dispatch_sending_orfao_vira_unknown', async () => {
  await config(tenant, 'integration.dispatch.sending_stale_s', 120);
  const velho = (await criar(tenant, con.id, chave())).dispatch;
  const novo = (await criar(tenant, con.id, chave())).dispatch;
  await forcar(tenant, velho.id, "status = 'SENDING', attempts = 1, updated_at = now() - interval '3 minutes'");
  await forcar(tenant, novo.id, "status = 'SENDING', attempts = 1, updated_at = now() - interval '30 seconds'");
  const rec = await comTenant(tenant, (t) => dispatch.recoverStaleSending(ctxDe(tenant), t));
  assert.ok(rec.some((r) => r.id === velho.id));
  assert.ok(!rec.some((r) => r.id === novo.id), 'SENDING recente não é tocado');
  const v = await ler(tenant, velho.id);
  assert.equal(v.status, 'UNKNOWN');
  assert.ok(v.unknown_since);
  assert.equal((await ler(tenant, novo.id)).status, 'SENDING');
  // O prazo é parâmetro da empresa: com 600 s, o de 3 minutos não seria recuperado.
  await config(tenant, 'integration.dispatch.sending_stale_s', 600);
  const outro3 = (await criar(tenant, con.id, chave())).dispatch;
  await forcar(tenant, outro3.id, "status = 'SENDING', attempts = 1, updated_at = now() - interval '3 minutes'");
  const rec2 = await comTenant(tenant, (t) => dispatch.recoverStaleSending(ctxDe(tenant), t));
  assert.ok(!rec2.some((r) => r.id === outro3.id));
  await config(tenant, 'integration.dispatch.sending_stale_s', 120);
});

test('dispatch_worker_skip_locked', async () => {
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await criar(tenant, con2.id, chave(), { operation: 'sendText' })).dispatch.id);
  const tA = await sequelize.transaction();
  const tB = await sequelize.transaction();
  try {
    for (const t of [tA, tB]) {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    }
    const a = (await dispatch.claimDue(ctxDe(tenant), 100, tA)).filter((r) => ids.includes(r.id));
    const b = (await dispatch.claimDue(ctxDe(tenant), 100, tB)).filter((r) => ids.includes(r.id));
    const idsA = new Set(a.map((r) => r.id));
    assert.ok(a.length >= 1);
    assert.ok(b.every((r) => !idsA.has(r.id)), 'dois workers nunca executam o mesmo envio');
    assert.equal(a.length + b.length, 6);
    assert.ok([...a, ...b].every((r) => r.status === 'SENDING' && r.attempts === 1));
    await tA.commit();
    await tB.commit();
  } catch (e) { await tA.rollback().catch(() => {}); await tB.rollback().catch(() => {}); throw e; }
  const de = await comTenant(tenant, (t) => dispatch.claimDue(ctxDe(tenant), 500, t));
  assert.ok(de.every((r) => !ids.includes(r.id)), '1 execução por envio');
});
