'use strict';

// M9-D900 (reabertura, auditoria M3): limite de execuções simultâneas por empresa e fonte, teto da empresa e teto global do processo. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const runsService = require('../../../src/features/migration-v2/ingest/runs.service');
const limiter = require('../../../src/features/migration-v2/ingest/run.limiter');
const { executeRun } = require('../../../src/features/migration-v2/ingest/executor');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const KEYS = { source: 'migracao.execucao.max_por_fonte', company: 'migracao.execucao.max_por_empresa', process: 'migracao.execucao.max_no_processo' };
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const request = (body) => env.openTenantTx(A(), (tx) => runsService.createRun(A(), { userId: A().userId }, body, tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(KEYS.source, 1);
  await setSetting(KEYS.company, 3);
  await setSetting(KEYS.process, 5);
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status IN ('QUEUED', 'RUNNING', 'PAUSED')", [A().companyId]);
});
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });

test('m9d900 ATK-4: 25 pedidos simultâneos para a mesma fonte aceitam só um', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  const results = await Promise.all(Array.from({ length: 25 }, () => codeOf(request({ sourceSystem: legacy.system }))));
  assert.equal(results.filter((code) => code === null).length, 1, 'uma execução aceita');
  assert.equal(results.filter((code) => code === 'GOV_MIG_RUN_ALREADY_ACTIVE').length, 24, 'as outras 24 recebem 409');
  const [row] = await env.q("SELECT count(*)::int AS n FROM governance.mig_runs WHERE company_id = $1 AND source_system = $2", [A().companyId, legacy.system]);
  assert.equal(row.n, 1);
  legacy.dispose();
});

test('m9d900 terminada a execução, a fonte aceita outro pedido', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  legacy.fake.event('1', 'I', 1, env.personRecord());
  const first = await env.run(A(), { sourceSystem: legacy.system });
  assert.equal(first.result.status, 'SUCCEEDED');
  assert.ok((await request({ sourceSystem: legacy.system })).runId, 'depois do fim, novo pedido passa');
  assert.equal(await codeOf(request({ sourceSystem: legacy.system })), 'GOV_MIG_RUN_ALREADY_ACTIVE', 'com um ativo, o seguinte é recusado');
  legacy.dispose();
});

test('m9d900 pedido sem filtro cruza com qualquer fonte ativa da empresa', { skip: skip() }, async () => {
  const one = await env.installSource(A(), { mode: 'CDC' });
  assert.ok((await request({ sourceSystem: one.system })).runId);
  assert.equal(await codeOf(request({})), 'GOV_MIG_RUN_ALREADY_ACTIVE', 'a execução de todas as fontes inclui a que está ativa');
  one.dispose();
});

test('m9d900 o parâmetro por fonte e o teto da empresa são lidos de verdade', { skip: skip() }, async () => {
  const [x, y, z] = [await env.installSource(A(), { mode: 'CDC' }), await env.installSource(A(), { mode: 'CDC' }), await env.installSource(A(), { mode: 'CDC' })];
  await setSetting(KEYS.source, 2);
  await setSetting(KEYS.company, 2);
  assert.ok((await request({ sourceSystem: x.system })).runId);
  assert.ok((await request({ sourceSystem: x.system })).runId, 'por fonte = 2: o segundo pedido da mesma fonte passa');
  assert.equal(await codeOf(request({ sourceSystem: y.system })), 'GOV_MIG_RUN_LIMIT', 'teto da empresa = 2: a terceira execução ativa é recusada com 429');
  await setSetting(KEYS.company, 3);
  assert.ok((await request({ sourceSystem: y.system })).runId, 'subindo o teto, passa');
  assert.equal(await codeOf(request({ sourceSystem: z.system })), 'GOV_MIG_RUN_LIMIT');
  for (const legacy of [x, y, z]) legacy.dispose();
});

test('m9d900 execução ativa vencida pelo prazo deixa de contar', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  const { runId } = await request({ sourceSystem: legacy.system });
  assert.equal(await codeOf(request({ sourceSystem: legacy.system })), 'GOV_MIG_RUN_ALREADY_ACTIVE');
  await env.adminQuery("UPDATE governance.mig_runs SET created_at = now() - interval '13 hours' WHERE id = $1", [runId]);
  assert.ok((await request({ sourceSystem: legacy.system })).runId, 'processo caído há mais que o prazo não trava a fonte para sempre');
  legacy.dispose();
});

test('m9d900 execução antiga que ainda grava lotes continua contando; sem atividade recente deixa de contar', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  legacy.fake.event('1', 'I', 1, env.personRecord());
  const first = await env.run(A(), { sourceSystem: legacy.system });
  const [batch] = await env.batchesOf(legacy.system);
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'RUNNING', finished_at = NULL, created_at = now() - interval '13 hours', started_at = now() - interval '13 hours' WHERE id = $1", [first.runId]);
  await env.adminQuery("UPDATE governance.mig_batches SET started_at = now() - interval '13 hours', finished_at = now() - interval '2 minutes' WHERE id = $1", [batch.id]);
  assert.equal(await codeOf(request({ sourceSystem: legacy.system })), 'GOV_MIG_RUN_ALREADY_ACTIVE', 'ainda grava lotes: não é processo caído');
  await env.adminQuery("UPDATE governance.mig_batches SET finished_at = now() - interval '13 hours' WHERE id = $1", [batch.id]);
  assert.ok((await request({ sourceSystem: legacy.system })).runId, 'parada há mais que o prazo: libera a fonte');
  legacy.dispose();
});

test('m9d900 teto global do processo: acima dele a execução fica QUEUED', { skip: skip() }, async () => {
  const legacy = await env.installSource(A(), { mode: 'CDC' });
  legacy.fake.event('1', 'I', 1, env.personRecord());
  const { runId } = await request({ sourceSystem: legacy.system });
  await setSetting(KEYS.process, 1);
  assert.ok(limiter.tryAcquire(1), 'uma vaga ocupada neste processo');
  try {
    assert.equal(await executeRun(A(), runId), null, 'sem vaga, não executa');
    assert.equal((await env.q('SELECT status FROM governance.mig_runs WHERE id = $1', [runId]))[0].status, 'QUEUED', 'continua na fila para o job retomar');
  } finally {
    limiter.release();
  }
  assert.equal(limiter.current(), 0);
  assert.equal((await executeRun(A(), runId)).status, 'SUCCEEDED', 'com vaga livre a mesma execução roda');
  assert.equal(limiter.current(), 0, 'a vaga é devolvida ao fim');
  legacy.dispose();
});
