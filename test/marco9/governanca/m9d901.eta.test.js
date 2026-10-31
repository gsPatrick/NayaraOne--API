'use strict';

// M9-D901 — ETA da Torre: vazão média dos últimos lotes (janela configurável), sem lotes é nulo, replays não contam. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const setWindow = (n) => env.openTenantTx(tenants.A, (tx) => upsertSetting('migracao.eta.janela_lotes', n, tenants.A, tenants.A.userId, tx));
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await setWindow(5); } });
after(async () => { if (env.DISPOSABLE) { await setWindow(5); await env.cleanMigration(); } await env.sequelize.close(); });
const A = () => tenants.A;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();

test('m9d901 ETA por vazão média dos últimos 5 lotes', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 100, PENDING: 2300 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  // seis lotes: o mais antigo (10 linhas/min) fica de fora da janela de 5; os cinco recentes dão 500 linhas/min cada
  await env.insertBatch(A(), legacy.system, 'PERSON', { rows: 100, minutes: 10, finishedAt: at(60), runId });
  for (let i = 1; i <= 5; i += 1) await env.insertBatch(A(), legacy.system, 'PERSON', { rows: 1000, minutes: 2, finishedAt: at(10 - i), status: i % 2 ? 'APPLIED' : 'VERIFIED', runId });
  const tower = await env.getTower(A(), runId);
  assert.deepEqual([tower.eta.batches, tower.eta.throughput_rows_per_min, tower.eta.eta_min, tower.eta.reason], [5, 500, 5, null]);
  assert.equal(tower.totals.not_started, 2300, 'ceil(2300 / 500) = 5');
  await setWindow(2);
  assert.equal((await env.getTower(A(), runId)).eta.batches, 2, 'a janela vem do parâmetro migracao.eta.janela_lotes');
  await setWindow(5);
  legacy.dispose();
});

test('m9d901 sem lotes o ETA é nulo', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { PENDING: 40 });
  const tower = await env.getTower(A(), await env.newRun(A(), legacy.system, 'PERSON'));
  assert.deepEqual([tower.eta.eta_min, tower.eta.reason, tower.eta.batches], [null, 'NO_BATCHES', 0]);
  legacy.dispose();
});

test('m9d901 vazão zero também dá ETA nulo com motivo, e lote de replay não conta na vazão', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { PENDING: 40 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  const original = await env.insertBatch(A(), legacy.system, 'PERSON', { rows: 0, minutes: 3, runId });
  await env.insertBatch(A(), legacy.system, 'PERSON', { rows: 9000, minutes: 1, runId, replayOf: original.id });
  const tower = await env.getTower(A(), runId);
  assert.deepEqual([tower.eta.eta_min, tower.eta.reason, tower.eta.throughput_rows_per_min, tower.eta.batches], [null, 'ZERO_THROUGHPUT', 0, 1]);
  legacy.dispose();
});

test('m9d901 o ETA cobre só o automático: quarentena e revisão aparecem à parte e nada pendente dá zero minuto', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  await env.seedRecords(A(), legacy.system, 'PERSON', { MIGRATED: 10, QUARANTINED: 3, PENDING_REVIEW: 2 });
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  await env.insertBatch(A(), legacy.system, 'PERSON', { rows: 600, minutes: 1, runId });
  const tower = await env.getTower(A(), runId);
  assert.equal(tower.eta.eta_min, 0, 'nenhum registro pendente de processamento');
  assert.deepEqual(tower.pending_human, { quarantined: 3, pending_review: 2 });
  legacy.dispose();
});
