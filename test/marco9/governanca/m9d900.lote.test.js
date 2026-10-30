'use strict';

// M9-D900 — lote: atomicidade e checkpoint, tentativas e ABORTED, concorrência na mesma fonte, máquina de estados K8 e tamanho do lote. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { overrideTarget, getTarget } = require('../../../src/features/migration-v2/ingest/targets');
const { runBatch, loadSettings } = require('../../../src/features/migration-v2/ingest/batch.runner');
const batchRepository = require('../../../src/features/migration-v2/ingest/batch.repository');
const states = require('../../../src/features/migration-v2/ingest/batch.states');

let tenants; let restore = null;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (restore) { restore(); restore = null; }
  if (env.DISPOSABLE) {
    await env.openTenantTx(tenants.A, (tx) => upsertSetting('migracao.lote.max_tentativas', 3, tenants.A, tenants.A.userId, tx));
    await env.openTenantTx(tenants.A, (tx) => upsertSetting('migracao.lote.tamanho', 2000, tenants.A, tenants.A.userId, tx));
  }
});
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);

/** Destino de PERSON que falha na linha `failAt` (1-based) nas primeiras `times` tentativas (Infinity = sempre). */
function flakyTarget({ failAt, times = Infinity, delayMs = 0 }) {
  const real = getTarget('PERSON');
  let calls = 0; let failures = 0;
  const wrapper = {
    ...real,
    async upsert(...args) {
      calls += 1;
      if (delayMs && calls === 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (calls >= failAt && failures < times) { failures += 1; throw new Error('falha injetada na linha'); }
      return real.upsert(...args);
    },
  };
  restore = overrideTarget('PERSON', wrapper);
  return { failures: () => failures };
}

async function loaded(n, mode = 'CDC') {
  const legacy = await env.installSource(A(), { mode });
  for (let i = 1; i <= n; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord());
  return legacy;
}
const persons = (system) => env.q('SELECT count(*)::int AS n FROM core.external_refs WHERE source_system = $1', [system]).then((r) => r[0].n);

test('m9d900 lote com falha não avança checkpoint', { skip: skip() }, async () => {
  await setSetting('migracao.lote.max_tentativas', 1);
  const legacy = await loaded(40);
  const flaky = flakyTarget({ failAt: 28 });
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.status, 'FAILED');
  assert.equal(flaky.failures(), 1);
  assert.equal(await persons(legacy.system), 0, 'nada aplicado: a transação do lote foi desfeita');
  assert.equal((await env.recordsOf(legacy.system)).length, 0);
  assert.equal((await env.keysOf(legacy.system)).length, 0, 'nem chave de idempotência');
  assert.equal((await legacy.source()).checkpoint_token, null, 'checkpoint inalterado');
  const [batch] = await env.batchesOf(legacy.system);
  assert.equal(batch.status, 'ABORTED');
  legacy.dispose();
});

test('m9d900 falha transitória: o lote volta a RUNNING e termina sem duplicar nada', { skip: skip() }, async () => {
  const legacy = await loaded(30);
  flakyTarget({ failAt: 20, times: 1 });
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.status, 'SUCCEEDED');
  const [batch] = await env.batchesOf(legacy.system);
  assert.deepEqual([batch.status, batch.attempts, batch.row_count], ['APPLIED', 2, 30]);
  assert.equal(await persons(legacy.system), 30);
  assert.equal((await env.keysOf(legacy.system)).length, 30);
  assert.equal((await legacy.source()).checkpoint_token, '30');
  legacy.dispose();
});

test('m9d900 lote com 3 falhas seguidas vai a ABORTED', { skip: skip() }, async () => {
  const legacy = await loaded(12);
  flakyTarget({ failAt: 5 });
  const { result } = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.sources[0].error.code, 'GOV_MIG_BATCH_ABORTED');
  const [batch] = await env.batchesOf(legacy.system);
  assert.deepEqual([batch.status, batch.attempts], ['ABORTED', 3]);
  assert.match(batch.error, /falha injetada/);
  assert.equal((await legacy.source()).checkpoint_token, null);
  const tenant = A();
  assert.equal(await codeOf(env.openTenantTx(tenant, (tx) => batchRepository.transition(tenant, batch.id, 'RUNNING', {}, tx))), 'GOV_MIG_BATCH_INVALID_TRANSITION', 'ABORTED é final: não há aborto nem reabertura manual');
  restore(); restore = null;
  const retry = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(retry.result.status, 'SUCCEEDED', 'corrigido o defeito, uma nova execução cria outro lote');
  assert.equal(await persons(legacy.system), 12);
  legacy.dispose();
});

test('m9d900 o parâmetro de tentativas manda no ABORTED', { skip: skip() }, async () => {
  await setSetting('migracao.lote.max_tentativas', 2);
  const legacy = await loaded(6);
  flakyTarget({ failAt: 3 });
  await env.run(A(), { sourceSystem: legacy.system });
  const [batch] = await env.batchesOf(legacy.system);
  assert.deepEqual([batch.status, batch.attempts], ['ABORTED', 2]);
  legacy.dispose();
});

test('m9d900 dois lotes simultâneos na mesma fonte: um vence', { skip: skip() }, async () => {
  const legacy = await loaded(9);
  flakyTarget({ failAt: 9999, delayMs: 700 });
  const source = await legacy.source();
  const settings = await loadSettings(A());
  const run = await env.openTenantTx(A(), (tx) => require('../../../src/features/migration-v2/ingest/runs.service').createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx));
  const plan = () => ({ fromToken: null, toToken: '9', events: legacy.fake.state.events });
  const first = runBatch(A(), { userId: A().userId }, run.runId, source, plan(), { settings });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await codeOf(runBatch(A(), { userId: A().userId }, run.runId, source, plan(), { settings }));
  const winner = await first;
  assert.equal(second, 'GOV_MIG_BATCH_RUNNING');
  assert.equal(winner.batch.status, 'APPLIED');
  const all = await env.batchesOf(legacy.system);
  assert.deepEqual([all.length, all.filter((b) => b.status === 'RUNNING').length], [1, 0], 'o perdedor não deixou lote para trás');
  assert.equal(await persons(legacy.system), 9, 'cada registro foi gravado uma só vez');
  legacy.dispose();
});

test('m9d900 o índice único também barra o segundo lote RUNNING da fonte', { skip: skip() }, async () => {
  const legacy = await loaded(1);
  const source = await legacy.source();
  const run = await env.openTenantTx(A(), (tx) => require('../../../src/features/migration-v2/ingest/runs.service').createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx));
  const open = () => env.openTenantTx(A(), async (tx) => batchRepository.insert(A(), { runId: run.runId, source, fromToken: null, toToken: '1' }, tx));
  const [one, two] = [await open(), await open()];
  await env.openTenantTx(A(), (tx) => batchRepository.transition(A(), one.id, 'RUNNING', {}, tx));
  const err = await env.openTenantTx(A(), (tx) => batchRepository.transition(A(), two.id, 'RUNNING', {}, tx)).then(() => null, (e) => e);
  assert.deepEqual([err.statusCode, err.code], [409, 'GOV_MIG_BATCH_RUNNING']);
  legacy.dispose();
});

test('m9d900 a mensagem de lote em execução é a do livro', { skip: skip() }, async () => {
  const errors = require('../../../src/features/migration-v2/ingest/ingest.errors');
  const e = errors.batchRunning();
  assert.deepEqual([e.statusCode, e.code, e.message], [409, 'GOV_MIG_BATCH_RUNNING', 'Já existe um lote em execução para esta fonte.']);
});

test('m9d900 máquina de estados do lote inclui VERIFIED e HASH_MISMATCH e recusa transição proibida', { skip: skip() }, async () => {
  const allowed = [['PLANNED', 'RUNNING'], ['RUNNING', 'APPLIED'], ['RUNNING', 'FAILED'], ['RUNNING', 'ABORTED'], ['FAILED', 'RUNNING'], ['APPLIED', 'VERIFIED'], ['APPLIED', 'HASH_MISMATCH'], ['HASH_MISMATCH', 'RUNNING']];
  for (const [from, to] of allowed) assert.equal(states.canTransition(from, to), true, `${from} -> ${to}`);
  const forbidden = [['PLANNED', 'APPLIED'], ['APPLIED', 'RUNNING'], ['APPLIED', 'FAILED'], ['VERIFIED', 'RUNNING'], ['VERIFIED', 'HASH_MISMATCH'], ['ABORTED', 'RUNNING'], ['FAILED', 'APPLIED'], ['HASH_MISMATCH', 'VERIFIED']];
  for (const [from, to] of forbidden) assert.equal(states.canTransition(from, to), false, `${from} -> ${to}`);
  assert.deepEqual([...states.FINAL].sort(), ['ABORTED', 'VERIFIED']);
  const legacy = await loaded(3);
  await env.run(A(), { sourceSystem: legacy.system });
  const [batch] = await env.batchesOf(legacy.system);
  const t = (to) => env.openTenantTx(A(), (tx) => batchRepository.transition(A(), batch.id, to, {}, tx));
  assert.equal((await t('HASH_MISMATCH')).status, 'HASH_MISMATCH');
  assert.equal((await t('RUNNING')).status, 'RUNNING', 'HASH_MISMATCH -> RUNNING (reaplicação)');
  assert.equal((await t('APPLIED')).status, 'APPLIED');
  assert.equal((await t('VERIFIED')).status, 'VERIFIED');
  const err = await t('RUNNING').then(() => null, (e) => e);
  assert.deepEqual([err.statusCode, err.code, err.message], [409, 'GOV_MIG_BATCH_INVALID_TRANSITION', 'Transição de estado inválida para o lote.']);
  legacy.dispose();
});

test('m9d900 o tamanho do lote vem do parâmetro e o checkpoint só anda lote a lote', { skip: skip() }, async () => {
  await setSetting('migracao.lote.tamanho', 10);
  const legacy = await loaded(25);
  await env.run(A(), { sourceSystem: legacy.system });
  const batches = await env.batchesOf(legacy.system);
  assert.deepEqual(batches.map((b) => [b.from_token, b.to_token, b.row_count, b.status]), [[null, '10', 10, 'APPLIED'], ['10', '20', 10, 'APPLIED'], ['20', '25', 5, 'APPLIED']]);
  assert.equal((await legacy.source()).checkpoint_token, '25');
  legacy.dispose();
});
