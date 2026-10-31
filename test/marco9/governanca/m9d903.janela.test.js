'use strict';

// M9-D903 — ciclo da janela: fora da janela não executa, intervalo, falha segura, fechamento só com zero diferenças e continuidade depois do ends_at. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d903Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d903 fora da janela não executa', { skip: skip() }, async () => {
  const A = tenants.A;
  const future = await env.scenario(A, { startMin: 60, endMin: 240 });
  await future.pair('f-1', env.GOOD_OLD, env.GOOD_NEW);
  assert.deepEqual(await env.tick(A, future.window.id, env.T0), { action: 'SKIPPED', reason: 'NOT_STARTED' });
  assert.equal((await env.windowRow(future.window.id)).status, 'SCHEDULED');
  assert.equal((await env.runsOf(future.window.id)).length, 0);
  assert.equal(future.legacy.fake.state.reads, 0, 'a origem nem é lida');
  const first = await env.tick(A, future.window.id, env.minutes(61));
  assert.equal(first.action, 'COMPLETED');
  assert.equal((await env.windowRow(future.window.id)).status, 'RUNNING', 'dentro do período a janela passa a RUNNING');
  await future.dispose();

  const past = await env.scenario(A, { startMin: -300, endMin: -120 }); // 03:00 de 28/10 com a janela até 27/10 23:59
  assert.deepEqual(await env.tick(A, past.window.id, env.T0), { action: 'SKIPPED', reason: 'EXPIRED' });
  assert.equal((await env.runsOf(past.window.id)).length, 0);
  await past.dispose();

  const closed = await env.scenario(A);
  await env.q("UPDATE governance.parallel_windows SET status = 'CLOSED', closed_at = now() WHERE id = $1", [closed.window.id]);
  assert.deepEqual(await env.tick(A, closed.window.id, env.T0), { action: 'SKIPPED', reason: 'CLOSED' });
  await closed.dispose();
});

test('m9d903 comparação periódica: respeita o intervalo da janela', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { intervalMin: 60, endMin: 600 });
  await s.pair('i-1', env.GOOD_OLD, env.GOOD_NEW);
  assert.equal((await env.tick(A, s.window.id, env.T0)).action, 'COMPLETED');
  assert.deepEqual(await env.tick(A, s.window.id, env.minutes(30)), { action: 'SKIPPED', reason: 'NOT_DUE' });
  const second = await env.tick(A, s.window.id, env.minutes(60));
  assert.deepEqual([second.action, second.runNumber], ['COMPLETED', 2]);
  assert.deepEqual((await env.runsOf(s.window.id)).map((r) => [r.run_number, r.status]), [[1, 'COMPLETED'], [2, 'COMPLETED']]);
  await s.dispose();
});

test('m9d903 execução que falha não conta como limpa', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { intervalMin: 60, endMin: 120 });
  const id = await s.pair('x-1', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 125001 });
  await env.tick(A, s.window.id, env.T0);
  assert.equal((await env.towerBlockers(A, s.system)).length, 1);
  const healthy = s.legacy.fake.connector.readAllRows;
  s.legacy.fake.connector.readAllRows = async () => { throw new Error('conexão recusada'); };
  const failed = await env.tick(A, s.window.id, env.minutes(200)); // depois do fim, com a fonte fora do ar
  assert.deepEqual([failed.action, failed.code], ['FAILED', 'GOV_PARALLEL_SOURCE_DOWN']);
  const runs = await env.runsOf(s.window.id);
  assert.deepEqual(runs.map((r) => [r.run_number, r.status, r.error_code]), [[1, 'COMPLETED', null], [2, 'FAILED', 'GOV_PARALLEL_SOURCE_DOWN']]);
  assert.equal((await env.results(s.window.id)).filter((r) => r.run_number === 2).length, 0, 'execução falha não grava resultado');
  assert.equal((await env.towerBlockers(A, s.system)).length, 1, 'a diferença segue aberta');
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING');
  s.legacy.fake.connector.readAllRows = healthy;
  s.side.store.set(id, { ...env.GOOD_NEW });
  const waiting = await env.tick(A, s.window.id, env.minutes(210));
  assert.equal(waiting.reason, 'NOT_DUE', 'depois da falha vale o intervalo, sem martelar a fonte');
  const retry = await env.tick(A, s.window.id, env.minutes(262));
  assert.deepEqual([retry.action, retry.runNumber, retry.closed], ['COMPLETED', 3, true]);
  await s.dispose();
});

test('m9d903 janela sem nenhuma execução concluída nunca fecha por falha', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { endMin: 30 });
  await s.pair('y-1', env.GOOD_OLD, env.GOOD_NEW);
  s.legacy.fake.connector.readAllRows = async () => { throw new Error('fora do ar'); };
  const failed = await env.tick(A, s.window.id, env.T0);
  assert.equal(failed.action, 'FAILED');
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING');
  const later = await env.tick(A, s.window.id, env.minutes(90)); // depois do fim, ainda fora do ar
  assert.equal(later.action, 'FAILED');
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING', 'sem execução concluída a janela não fecha');
  await s.dispose();
});

test('m9d903 execução RUNNING esquecida (processo caído) vira FAILED e libera a janela; a recente bloqueia', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { endMin: 600 });
  await s.pair('z-1', env.GOOD_OLD, env.GOOD_NEW);
  await env.q("UPDATE governance.parallel_windows SET status = 'RUNNING' WHERE id = $1", [s.window.id]);
  await env.q(`INSERT INTO governance.parallel_runs (group_id, company_id, window_id, run_number, started_at) VALUES ($1, $2, $3, 1, $4)`, [A.groupId, A.companyId, s.window.id, env.minutes(-5).toISOString()]);
  assert.deepEqual(await env.tick(A, s.window.id, env.T0), { action: 'SKIPPED', reason: 'BUSY' });
  const freed = await env.tick(A, s.window.id, env.minutes(70)); // 75 min depois: passou do prazo de 30 e do intervalo
  assert.deepEqual([freed.action, freed.runNumber], ['COMPLETED', 2]);
  assert.deepEqual((await env.runsOf(s.window.id)).map((r) => [r.status, r.error_code]), [['FAILED', 'GOV_PARALLEL_RUN_TIMEOUT'], ['COMPLETED', null]]);
  await s.dispose();
});

test('m9d903 o job só fecha a janela com blockers zerados', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { intervalMin: 60, endMin: 120 });
  const id = await s.pair('j-1', env.GOOD_OLD, { ...env.GOOD_NEW, name: 'Outro nome' });
  const before = await env.runJob(A, env.T0);
  assert.ok(before.runs >= 1);
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING');
  const atEnd = await env.tick(A, s.window.id, env.minutes(121));
  assert.equal(atEnd.closed, false, 'passou do fim, mas há diferença aberta');
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING');
  s.side.store.set(id, { ...env.GOOD_NEW });
  const done = await env.runJob(A, env.minutes(200));
  assert.ok(done.closed >= 1);
  const row = await env.windowRow(s.window.id);
  assert.equal(row.status, 'CLOSED');
  assert.ok(row.closed_at);
  const audits = await env.q("SELECT action FROM audit.audit_log WHERE entity_id = $1 ORDER BY created_at", [s.window.id]);
  assert.deepEqual(audits.map((a) => a.action).filter((a) => a.startsWith('migration.parallel.window')), ['migration.parallel.window.created', 'migration.parallel.window.started', 'migration.parallel.window.closed']);
  await s.dispose();
});

test('m9d903 janela RUNNING com blockers continua comparando após ends_at e fecha quando zeram', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { intervalMin: 60, endMin: 120 });
  const id = await s.pair('g-1', env.GOOD_OLD, { ...env.GOOD_NEW, amount: 125001 });
  await env.tick(A, s.window.id, env.T0);
  for (const [at, expected] of [[121, 'COMPLETED'], [185, 'COMPLETED'], [250, 'COMPLETED']]) {
    const out = await env.tick(A, s.window.id, env.minutes(at));
    assert.deepEqual([out.action, out.closed], [expected, false], `execução aos ${at} min, após o fim`);
  }
  assert.equal((await env.runsOf(s.window.id)).length, 4);
  assert.equal((await env.windowRow(s.window.id)).status, 'RUNNING');
  assert.equal((await env.towerBlockers(A, s.system)).length, 1);
  s.side.store.set(id, { ...env.GOOD_NEW });
  assert.deepEqual(await env.tick(A, s.window.id, env.minutes(260)), { action: 'SKIPPED', reason: 'NOT_DUE' });
  const last = await env.tick(A, s.window.id, env.minutes(315));
  assert.deepEqual([last.action, last.closed, last.openBlockers], ['COMPLETED', true, 0]);
  assert.equal((await env.windowRow(s.window.id)).status, 'CLOSED');
  assert.deepEqual(await env.towerBlockers(A, s.system), []);
  assert.deepEqual(await env.tick(A, s.window.id, env.minutes(400)), { action: 'SKIPPED', reason: 'CLOSED' });
  await s.dispose();
});

test('m9d903 ao chegar o ends_at a janela limpa faz uma comparação final e fecha, sem esperar o intervalo', { skip: skip() }, async () => {
  const A = tenants.A;
  const s = await env.scenario(A, { intervalMin: 600, endMin: 180 });
  await s.pair('e-1', env.GOOD_OLD, env.GOOD_NEW);
  assert.equal((await env.tick(A, s.window.id, env.T0)).closed, false, 'antes do fim não fecha');
  const final = await env.tick(A, s.window.id, env.minutes(181));
  assert.deepEqual([final.action, final.runNumber, final.closed], ['COMPLETED', 2, true]);
  assert.equal((await env.windowRow(s.window.id)).status, 'CLOSED');
  await s.dispose();
});
