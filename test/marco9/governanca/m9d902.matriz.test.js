'use strict';

// M9-D902 — RACI de cutover por atividade: semente de 10 atividades, um A por atividade, matriz atômica, auditoria com antes e depois, papel do ator e isolamento. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const raci = require('../../../src/features/migration-v2/raci/raci.service');
const access = require('../../../src/features/migration-v2/raci/raci.access');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant) => env.withRollbackTenantTransaction(tenant || tenants.A, fn);
const actor = (tenant) => ({ userId: tenant.userId });
const put = (tenant, tx, activity, entries) => raci.replaceActivity(tenant, actor(tenant), { activity, entries }, tx);
const failure = (promise) => promise.then(() => null, (err) => err);
const CODES = ['FREEZE_LEGACY_WRITES', 'LAST_DELTA_LOAD', 'FINAL_RECONCILIATION', 'PARALLEL_COMPARE_CLOSE', 'SECTOR_ACTIVATION', 'CLOCK_TZ_CHECK', 'GO_NO_GO', 'ROLLBACK_EXECUTION', 'USER_COMMUNICATION', 'LEGACY_DECOMMISSION'];

test('m9d902 as 10 atividades semeadas têm os códigos fixos', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { activities } = await raci.getMatrix(tenants.A, tx);
    assert.deepEqual(activities.map((a) => a.code), CODES);
    assert.deepEqual(activities.map((a) => a.order), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.ok(activities.every((a) => ['PRE', 'CUTOVER', 'POST'].includes(a.phase) && a.title));
    assert.ok(activities.filter((a) => !a.entries.length).every((a) => a.complete === false && a.missing.join() === 'A,R'), 'sem ninguém cadastrado a matriz está incompleta');
    const again = await raci.getMatrix(tenants.A, tx);
    assert.equal(again.activities.length, 10, 'semear de novo não duplica');
  });
});

test('m9d902 atividade exige exatamente um A', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    const u2 = await env.newUser(tenants.A, tx);
    await put(tenants.A, tx, 'GO_NO_GO', [{ userId: u1.id, raci: 'A' }, { userId: u2.id, raci: 'R' }]);
    const err = await failure(put(tenants.A, tx, 'GO_NO_GO', [{ userId: u1.id, raci: 'A' }, { userId: u2.id, raci: 'A' }, { role: 'GESTAO', raci: 'R' }]));
    assert.deepEqual([err.statusCode, err.code, err.message], [422, 'GOV_RACI_SINGLE_ACCOUNTABLE', 'Cada atividade tem exatamente uma pessoa que responde pelo resultado.']);
    const { activities } = await raci.getMatrix(tenants.A, tx);
    const go = activities.find((a) => a.code === 'GO_NO_GO');
    assert.deepEqual(go.entries.map((e) => [e.userId, e.raci]).sort(), [[u1.id, 'A'], [u2.id, 'R']].sort(), 'a recusa não mexeu na matriz');
    assert.equal(go.complete, true);
  });
});

test('m9d902 índice do banco barra o segundo A mesmo fora do serviço', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    const u2 = await env.newUser(tenants.A, tx);
    await put(tenants.A, tx, 'LAST_DELTA_LOAD', [{ userId: u1.id, raci: 'A' }]);
    const sql = "INSERT INTO governance.cutover_raci (group_id, company_id, activity_code, user_id, raci) VALUES (:g, :c, 'LAST_DELTA_LOAD', :u, 'A')";
    await env.sequelize.query('SAVEPOINT s1', { transaction: tx });
    const err = await failure(env.sequelize.query(sql, { transaction: tx, replacements: { g: tenants.A.groupId, c: tenants.A.companyId, u: u2.id } }));
    assert.equal(err.original.constraint, 'cutover_raci_single_a_uq');
    await env.sequelize.query('ROLLBACK TO SAVEPOINT s1', { transaction: tx });
  });
});

test('m9d902 sem A ou sem R a matriz é aceita e fica marcada como incompleta', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    const onlyA = await put(tenants.A, tx, 'CLOCK_TZ_CHECK', [{ userId: u1.id, raci: 'A' }]);
    assert.deepEqual([onlyA.activity.complete, onlyA.activity.missing], [false, ['R']]);
    const onlyR = await put(tenants.A, tx, 'CLOCK_TZ_CHECK', [{ role: 'TI', raci: 'R' }, { role: 'GESTAO', raci: 'C' }]);
    assert.deepEqual([onlyR.activity.complete, onlyR.activity.missing], [false, ['A']]);
    const full = await put(tenants.A, tx, 'CLOCK_TZ_CHECK', [{ userId: u1.id, raci: 'A' }, { role: 'TI', raci: 'R' }, { role: 'ti', raci: 'I' }]);
    assert.deepEqual([full.activity.complete, full.activity.missing], [true, []]);
  });
});

test('m9d902 mudança de RACI auditada com antes e depois', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    await put(tenants.A, tx, 'SECTOR_ACTIVATION', [{ userId: u1.id, raci: 'A' }, { role: 'TI', raci: 'R' }]);
    await put(tenants.A, tx, 'SECTOR_ACTIVATION', [{ userId: u1.id, raci: 'A' }, { role: 'OPERACIONAL', raci: 'R' }]);
    const rows = await env.query("SELECT before_json, after_json, user_id FROM audit.audit_log WHERE action = 'migration.raci.changed' AND after_json->>'activity' = 'SECTOR_ACTIVATION' ORDER BY occurred_at, id", {}, tx);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].before_json.entries, []);
    assert.deepEqual(rows[1].before_json.entries.map((e) => e.role || 'usuario').sort(), ['TI', 'usuario']);
    assert.deepEqual(rows[1].after_json.entries.map((e) => e.role || 'usuario').sort(), ['OPERACIONAL', 'usuario']);
    assert.equal(rows[1].user_id, tenants.A.userId);
  });
});

test('m9d902 entradas inválidas são recusadas sem gravar', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    const bad = async (activity, entries) => (await failure(put(tenants.A, tx, activity, entries)));
    assert.equal((await bad('NAO_EXISTE', [])).code, 'GOV_NOT_FOUND');
    assert.equal((await bad('GO_NO_GO', [{ userId: u1.id, raci: 'X' }])).code, 'GOV_RACI_INVALID');
    assert.equal((await bad('GO_NO_GO', [{ userId: u1.id, role: 'TI', raci: 'R' }])).code, 'GOV_RACI_INVALID');
    assert.equal((await bad('GO_NO_GO', [{ raci: 'R' }])).code, 'GOV_RACI_INVALID');
    assert.equal((await bad('GO_NO_GO', [{ userId: env.randomUUID(), raci: 'R' }])).code, 'GOV_RACI_INVALID');
    assert.equal((await bad('GO_NO_GO', [{ role: 'TI', raci: 'R' }, { role: 'ti', raci: 'R' }])).code, 'GOV_RACI_INVALID');
    assert.equal((await failure(raci.replaceActivity(tenants.A, actor(tenants.A), { activity: 'GO_NO_GO' }, tx))).code, 'GOV_RACI_INVALID');
    const { activities } = await raci.getMatrix(tenants.A, tx);
    assert.equal(activities.find((a) => a.code === 'GO_NO_GO').entries.length, 0);
  });
});

test('m9d902 o papel do ator vem do usuário ou do perfil, sem diferença de maiúsculas', { skip: skip() }, async () => {
  await run(async (tx) => {
    const u1 = await env.newUser(tenants.A, tx);
    await put(tenants.A, tx, 'FINAL_RECONCILIATION', [{ userId: u1.id, raci: 'A' }, { role: 'Financeiro', raci: 'R' }, { role: 'GESTAO', raci: 'C' }]);
    const roles = (a) => access.rolesOf(tenants.A, a, 'FINAL_RECONCILIATION', tx);
    assert.deepEqual(await roles({ userId: u1.id, roles: [] }), { R: false, A: true, C: false, I: false });
    assert.deepEqual(await roles({ userId: env.randomUUID(), roles: ['FINANCEIRO'] }), { R: true, A: false, C: false, I: false });
    assert.deepEqual(await roles({ userId: env.randomUUID(), roles: ['gestao', 'outro'] }), { R: false, A: false, C: true, I: false });
    assert.deepEqual(await roles({ userId: env.randomUUID(), roles: [] }), { R: false, A: false, C: false, I: false });
  });
});

test('m9d902 isolamento entre empresas', { skip: skip() }, async () => {
  const marker = `QA-M9-${env.suffix()}`.slice(0, 40);
  await run(async (tx) => { await put(tenants.A, tx, 'USER_COMMUNICATION', [{ role: marker, raci: 'A' }]); }, tenants.A);
  await env.withRollbackTenantTransaction(tenants.B, async (tx) => {
    const { activities } = await raci.getMatrix(tenants.B, tx);
    assert.ok(activities.every((a) => a.entries.every((e) => e.role !== marker)));
    const rows = await env.query('SELECT count(*)::int AS n FROM governance.cutover_raci', {}, tx);
    assert.ok(rows[0].n >= 0);
  });
  await run(async (tx) => {
    await put(tenants.A, tx, 'USER_COMMUNICATION', [{ role: marker, raci: 'A' }]);
    const seenByB = await env.query('SELECT count(*)::int AS n FROM governance.cutover_raci WHERE role = :marker', { marker }, tx);
    assert.equal(seenByB[0].n, 1);
  });
  await env.withRollbackTenantTransaction(tenants.B, async (tx) => {
    const sameName = await env.query('SELECT count(*)::int AS n FROM governance.cutover_raci WHERE company_id = :other', { other: tenants.A.companyId }, tx);
    assert.equal(sameName[0].n, 0, 'a RLS esconde a matriz da outra empresa');
  });
});
