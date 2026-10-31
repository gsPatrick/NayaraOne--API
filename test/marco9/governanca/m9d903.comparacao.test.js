'use strict';

// M9-D903 — o comparador pareia pelo ID legado, aplica a regra de cada campo e abre/fecha os blockers da Torre (M9-D901). Banco descartável, origem e destino simulados.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d903Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const rowsOf = (all, field, key) => all.filter((r) => r.field === field && (!key || r.source_key === key));

test('m9d903 parallel compare detecta diferença de 1 centavo (MONEY, tolerância 0)', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('c-ok', env.GOOD_OLD, env.GOOD_NEW);
  await s.pair('c-cent', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 125001 });
  const out = await env.tick(A, s.window.id, env.T0);
  assert.equal(out.action, 'COMPLETED');
  const all = await env.results(s.window.id);
  const amount = rowsOf(all, 'amount');
  assert.deepEqual(amount.map((r) => [r.source_key, r.result, r.diff_kind]), [['c-cent', 'DIFF_BLOCKER', 'VALUE']]);
  assert.equal(out.summary.DIFF_BLOCKER, 1);
  assert.equal(out.openBlockers, 1);
  await s.dispose();
});

test('m9d903 status mapeado é DIFF_ALLOWED e não abre blocker', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('m-1', env.GOOD_OLD, env.GOOD_NEW);
  await s.pair('m-2', { ...env.GOOD_OLD, st: 'ENCERRADO' }, { ...env.GOOD_NEW, status: 'CLOSED' });
  const out = await env.tick(A, s.window.id, env.T0);
  const status = rowsOf(await env.results(s.window.id), 'status');
  assert.deepEqual(status.map((r) => [r.source_key, r.result]), [['m-1', 'DIFF_ALLOWED'], ['m-2', 'DIFF_ALLOWED']]);
  assert.equal(out.summary.DIFF_ALLOWED, 2);
  assert.equal(out.openBlockers, 0);
  assert.deepEqual(await env.towerBlockers(A, s.system), []);
  await s.dispose();
});

test('m9d903 qualquer diferença não mapeada abre blocker na Torre (1 campo em 1.000)', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  for (let i = 0; i < 250; i += 1) await s.pair(`k${String(i).padStart(3, '0')}`, { ...env.GOOD_OLD, nm: `Contrato ${i}` }, { ...env.GOOD_NEW, name: `Contrato ${i}` });
  await s.pair('k-dif', env.GOOD_OLD, { ...env.GOOD_NEW, name: 'Contrato B' });
  const out = await env.tick(A, s.window.id, env.T0);
  assert.equal(out.summary.fields, 251 * 4);
  assert.equal(out.summary.DIFF_BLOCKER, 1);
  const blockers = await env.towerBlockers(A, s.system);
  assert.equal(blockers.length, 1);
  const [b] = blockers;
  assert.deepEqual([b.code, b.entity], ['GOV_PARALLEL_DIFF_BLOCKER', env.ENTITY]);
  assert.deepEqual([b.detail.source_key, b.detail.field, b.detail.kind, b.detail.window_id], ['k-dif', 'name', 'VALUE', s.window.id]);
  assert.ok(b.ref.length <= 128);
  assert.equal((await env.openBlockers(A, 'GOV_PARALLEL_DIFF_BLOCKER')).filter((x) => x.detail.source_system === s.system).length, 1);
  await s.dispose();
});

test('m9d903 registro ausente é bloqueante (MISSING_IN_NEW e MISSING_IN_OLD)', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('p-ok', env.GOOD_OLD, env.GOOD_NEW);
  s.legacy.fake.row('so-legado', env.T0, env.GOOD_OLD); // existe só no legado
  const orphan = await s.pair('so-novo', env.GOOD_OLD, env.GOOD_NEW); // existe só no novo
  s.legacy.fake.drop('so-novo');
  await s.pair('sem-linha', env.GOOD_OLD, env.GOOD_NEW); // tem referência, mas a linha do destino sumiu
  s.side.store.delete((await env.q("SELECT entity_id FROM core.external_refs WHERE source_system = $1 AND source_key = 'sem-linha'", [s.system]))[0].entity_id);
  const out = await env.tick(A, s.window.id, env.T0);
  assert.equal(out.summary.MISSING_IN_NEW, 2);
  assert.equal(out.summary.MISSING_IN_OLD, 1);
  const missing = (await env.results(s.window.id)).filter((r) => r.diff_kind && r.diff_kind.startsWith('MISSING'));
  assert.deepEqual(missing.map((r) => [r.source_key, r.diff_kind, r.result, r.field]).sort(), [['sem-linha', 'MISSING_IN_NEW', 'DIFF_BLOCKER', ''], ['so-legado', 'MISSING_IN_NEW', 'DIFF_BLOCKER', ''], ['so-novo', 'MISSING_IN_OLD', 'DIFF_BLOCKER', '']]);
  const codes = (await env.towerBlockers(A, s.system)).map((b) => b.code).sort();
  assert.deepEqual(codes, ['GOV_PARALLEL_MISSING_IN_NEW', 'GOV_PARALLEL_MISSING_IN_NEW', 'GOV_PARALLEL_MISSING_IN_OLD']);
  assert.ok(orphan);
  await s.dispose();
});

test('m9d903 registro excluído na origem e marcado no destino não é diferença', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('del-1', env.GOOD_OLD, env.GOOD_NEW);
  s.legacy.fake.drop('del-1');
  await env.q(`INSERT INTO governance.mig_records (group_id, company_id, source_system, entity, source_key, state, source_deleted, row_hash) VALUES ($1, $2, $3, $4, 'del-1', 'MIGRATED', true, 'h')`, [A.groupId, A.companyId, s.system, env.ENTITY]);
  const out = await env.tick(A, s.window.id, env.T0);
  assert.equal(out.summary.MISSING_IN_OLD, 0);
  assert.equal(out.openBlockers, 0);
  await s.dispose();
});

test('m9d903 resultados não guardam valor em claro, só hash', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('h-1', { ...env.GOOD_OLD, nm: 'Maria da Silva Sauro' }, { ...env.GOOD_NEW, name: 'Maria da Silva Rex', amount: 987654 });
  await env.tick(A, s.window.id, env.T0);
  await env.towerBlockers(A, s.system);
  const all = await env.results(s.window.id);
  assert.ok(all.length >= 2);
  for (const r of all) {
    for (const col of ['old_value_hash', 'new_value_hash']) assert.ok(r[col] === null || /^[0-9a-f]{64}$/.test(r[col]), col);
  }
  const dump = JSON.stringify({ all, blockers: await env.openBlockers(A), runs: await env.runsOf(s.window.id) });
  for (const clear of ['Maria da Silva', 'Sauro', 'Rex', '987654', '125000']) assert.ok(!dump.includes(clear), `não pode haver ${clear} em claro`);
  const audits = await env.q("SELECT after_json::text AS j FROM audit.audit_log WHERE action LIKE 'migration.parallel.%' AND entity_id IN ($1)", [s.window.id]);
  for (const a of audits) assert.ok(!a.j.includes('Maria'));
  await s.dispose();
});

test('m9d903 DIFF_BLOCKER sai da Torre quando a execução seguinte devolve MATCH', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  const id = await s.pair('r-1', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 125001 });
  await env.tick(A, s.window.id, env.T0);
  assert.equal((await env.towerBlockers(A, s.system)).length, 1);
  assert.equal((await env.openBlockers(A, 'GOV_PARALLEL_DIFF_BLOCKER')).some((b) => b.detail.window_id === s.window.id), true);
  s.side.store.set(id, { ...env.GOOD_NEW }); // corrigido no destino
  const out = await env.tick(A, s.window.id, env.minutes(60));
  assert.equal(out.action, 'COMPLETED');
  assert.equal(out.openBlockers, 0);
  const amount = rowsOf(await env.results(s.window.id), 'amount');
  assert.deepEqual(amount.map((r) => [r.run_number, r.result]), [[1, 'DIFF_BLOCKER'], [2, 'MATCH']]);
  assert.deepEqual(await env.towerBlockers(A, s.system), []);
  assert.equal((await env.openBlockers(A, 'GOV_PARALLEL_DIFF_BLOCKER')).some((b) => b.detail.window_id === s.window.id), false);
  await s.dispose();
});

test('m9d903 a diferença some também quando o registro deixa de existir nos dois lados', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A);
  await s.pair('gone-1', env.GOOD_OLD, env.GOOD_NEW);
  s.legacy.fake.row('so-legado-2', env.T0, env.GOOD_OLD);
  await env.tick(A, s.window.id, env.T0);
  assert.equal((await env.towerBlockers(A, s.system)).length, 1);
  s.legacy.fake.drop('so-legado-2');
  const out = await env.tick(A, s.window.id, env.minutes(60));
  assert.equal(out.openBlockers, 0);
  assert.deepEqual(await env.towerBlockers(A, s.system), []);
  await s.dispose();
});
