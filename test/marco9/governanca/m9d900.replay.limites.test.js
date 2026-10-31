'use strict';

// M9-D900 (reabertura N3 da reauditoria rodada 2): o replay de lote respeita os mesmos limites de concorrência da execução (por fonte, por empresa e por processo), porque cada
// replay relê o legado. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { replayBatch } = require('../../../src/features/migration-v2/ingest/replay');
const runsService = require('../../../src/features/migration-v2/ingest/runs.service');
const runRepository = require('../../../src/features/migration-v2/ingest/run.repository');
const limiter = require('../../../src/features/migration-v2/ingest/run.limiter');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const KEYS = { source: 'migracao.execucao.max_por_fonte', company: 'migracao.execucao.max_por_empresa', process: 'migracao.execucao.max_no_processo' };
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const replay = (batchId) => replayBatch(A(), { userId: A().userId }, batchId);
const codeOf = (promise) => promise.then(() => null, (err) => err.code);
const activeRuns = async () => (await env.q("SELECT count(*)::int AS n FROM governance.mig_runs WHERE company_id = $1 AND status IN ('QUEUED', 'RUNNING', 'PAUSED')", [A().companyId]))[0].n;

/** Fonte CDC com 3 eventos já aplicados: devolve a fonte e o lote original. */
async function appliedSource() {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  for (let i = 1; i <= 3; i += 1) legacy.fake.event(`${i}`, 'I', i, env.personRecord());
  await env.run(A(), { sourceSystem: legacy.system });
  const [batch] = await env.batchesOf(legacy.system);
  return { legacy, batch };
}

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(KEYS.source, 1);
  await setSetting(KEYS.company, 3);
  await setSetting(KEYS.process, 5);
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status IN ('QUEUED', 'RUNNING', 'PAUSED')", [A().companyId]);
  await env.cleanMigration();
});
after(async () => { await env.sequelize.close(); });

test('m9d900 N3: 25 replays simultâneos do mesmo lote aceitam um e leem o legado uma vez', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  // o replay aceito fica preso na leitura do legado até os outros 24 serem decididos: o pico de leituras é o que o limite controla
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let entered = 0; const read = legacy.fake.connector.readEvents;
  legacy.fake.connector.readEvents = async (args) => { entered += 1; await gate; return read(args); };
  const codes = []; let accepted = null;
  const all = Array.from({ length: 25 }, () => replay(batch.id).then((res) => { accepted = res; }, (err) => codes.push(err.code)));
  for (let i = 0; i < 200 && codes.length < 24; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(codes.length, 24, 'os 24 pedidos extras são decididos enquanto o primeiro ainda lê');
  assert.ok(codes.every((code) => code === 'GOV_MIG_RUN_ALREADY_ACTIVE'), 'todos com 409');
  assert.equal(entered, 1, 'pico de uma leitura no legado, não de 25');
  release();
  await Promise.all(all);
  assert.ok(accepted && accepted.batch.id, 'o replay aceito termina');
  assert.equal((await env.batchesOf(legacy.system)).length, 2, 'um único lote novo');
  legacy.dispose();
});

test('m9d900 N3: terminado o replay, a fonte aceita outro; o registro de controle do replay é do tipo REPLAY e a Torre não a toma por execução', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  await replay(batch.id);
  const tickets = await env.q("SELECT status, kind FROM governance.mig_runs WHERE company_id = $1 AND kind = 'REPLAY'", [A().companyId]);
  assert.deepEqual(tickets.map((t) => [t.status, t.kind]), [['SUCCEEDED', 'REPLAY']], 'o registro de controle do replay termina SUCCEEDED');
  assert.equal(await activeRuns(), 0, 'nada fica ativo');
  const latest = await env.openTenantTx(A(), (tx) => runRepository.latest(A(), tx));
  assert.equal(latest.id, batch.run_id, 'a Torre continua mostrando a execução, não o replay');
  assert.ok((await replay(batch.id)).batch.id, 'novo replay passa depois do fim do anterior');
  legacy.dispose();
});

test('m9d900 N3: replay contra execução ativa da mesma fonte é recusado; de outra fonte passa', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  const other = await env.installSource(A(), { mode: 'CDC' });
  await setSetting(KEYS.company, 5);
  await env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: legacy.system }, tx));
  assert.equal(await codeOf(replay(batch.id)), 'GOV_MIG_RUN_ALREADY_ACTIVE');
  await env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: other.system }, tx));
  legacy.dispose(); other.dispose();
});

test('m9d900 N3: o replay conta no teto da empresa (429) e o parâmetro é lido de verdade', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  const other = await env.installSource(A(), { mode: 'CDC' });
  await setSetting(KEYS.company, 1);
  await env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, { sourceSystem: other.system }, tx));
  assert.equal(await codeOf(replay(batch.id)), 'GOV_MIG_RUN_LIMIT', 'teto da empresa = 1 e já há uma execução');
  await setSetting(KEYS.company, 3);
  assert.ok((await replay(batch.id)).batch.id, 'subindo o teto, o replay passa');
  legacy.dispose(); other.dispose();
});

test('m9d900 N3: sem vaga no processo o replay é recusado (429), não deixa execução ativa', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  await setSetting(KEYS.process, 1);
  assert.ok(limiter.tryAcquire(1), 'vaga do processo ocupada');
  try {
    assert.equal(await codeOf(replay(batch.id)), 'GOV_MIG_RUN_LIMIT');
  } finally {
    limiter.release();
  }
  assert.equal(limiter.current(), 0);
  assert.equal(await activeRuns(), 0, 'a recusa não deixa execução ativa');
  assert.ok((await replay(batch.id)).batch.id, 'com a vaga livre passa');
  assert.equal(limiter.current(), 0, 'a vaga é devolvida ao fim');
  legacy.dispose();
});

test('m9d900 N3: replay que falha encerra o registro de controle como FAILED e devolve a vaga', { skip: skip() }, async () => {
  const { legacy, batch } = await appliedSource();
  legacy.fake.connector.readEvents = async () => { throw new Error('QA-M9 legado fora do ar'); };
  await assert.rejects(replay(batch.id), /legado fora do ar/);
  const [ticket] = await env.q("SELECT status FROM governance.mig_runs WHERE company_id = $1 AND kind = 'REPLAY'", [A().companyId]);
  assert.equal(ticket.status, 'FAILED');
  assert.equal(limiter.current(), 0);
  assert.equal(await activeRuns(), 0);
  legacy.dispose();
});
