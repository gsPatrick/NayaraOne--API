'use strict';

// M9-D900 (reabertura R4-L6 da rodada 4): o registro de controle de um replay expira pelo SINAL DE VIDA, não pela duração. Replay legítimo e longo, que ainda renova o sinal
// (`heartbeat_at`, a cada `migracao.execucao.sinal_vida_s`), mantém a vaga; só o que parou de renovar (processo caído) vence. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { cleanMigrationSettings } = require('../_helpers/m9d900Clean');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { admitReplay } = require('../../../src/features/migration-v2/ingest/run.admission');
const heartbeat = require('../../../src/features/migration-v2/ingest/run.heartbeat');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const BEAT = 'migracao.execucao.sinal_vida_s';
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);
const admit = (system) => env.openTenantTx(A(), (tx) => admitReplay(A(), { userId: A().userId }, { sourceSystem: system, entity: 'PERSON' }, tx));
const insertTicket = async (system, startedMinAgo, beatMinAgo) => (await env.q(
  `INSERT INTO governance.mig_runs (group_id, company_id, source_system, entity, kind, status, started_at, heartbeat_at, requested_by)
   VALUES ($1, $2, $3, 'PERSON', 'REPLAY', 'RUNNING', now() - make_interval(mins => $4::int), CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END, $6) RETURNING id`,
  [A().groupId, A().companyId, system, startedMinAgo, beatMinAgo, A().userId]))[0].id;
const statusOf = async (id) => (await env.q('SELECT status FROM governance.mig_runs WHERE id = $1', [id]))[0].status;
const beatOf = async (id) => new Date((await env.q('SELECT heartbeat_at FROM governance.mig_runs WHERE id = $1', [id]))[0].heartbeat_at).getTime();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(BEAT, 30);
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status IN ('QUEUED', 'RUNNING', 'PAUSED')", [A().companyId]);
  await env.cleanMigration();
});
after(async () => { if (env.DISPOSABLE) await cleanMigrationSettings(); await env.sequelize.close(); });

test('m9d900 R4-L6: replay longo que ainda renova o sinal de vida mantém a vaga (409), mesmo iniciado há mais que o prazo', { skip: skip() }, async () => {
  const system = env.sysName();
  const live = await insertTicket(system, 120, 1);
  assert.equal(await codeOf(admit(system)), 'GOV_MIG_RUN_ALREADY_ACTIVE', 'iniciado há 120 min, mas com sinal há 1 min: segue ativo');
  assert.equal(await statusOf(live), 'RUNNING');
});

test('m9d900 R4-L6: replay sem sinal de vida há mais que o prazo expira e libera a vaga; sem sinal nenhum vale o início', { skip: skip() }, async () => {
  const system = env.sysName();
  const dead = await insertTicket(system, 120, 60);
  assert.equal(await codeOf(admit(system)), null, 'sem sinal há 60 min (prazo 30): expirou');
  assert.equal(await statusOf(dead), 'FAILED');
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status = 'RUNNING'", [A().companyId]);
  const legacy = await insertTicket(system, 60, null);
  assert.equal(await codeOf(admit(system)), null, 'registro sem sinal e iniciado há 60 min expira pelo início');
  assert.equal(await statusOf(legacy), 'FAILED');
});

test('m9d900 R4-L6: o sinal é renovado no intervalo do parâmetro enquanto o replay vive e para quando ele termina', { skip: skip() }, async () => {
  const system = env.sysName();
  await setSetting(BEAT, 1);
  const id = await insertTicket(system, 10, 10);
  const before = await beatOf(id);
  const stop = await heartbeat.start(A(), id);
  await wait(2600);
  const renewed = await beatOf(id);
  assert.ok(renewed - before > 9 * 60 * 1000, 'o sinal saltou de 10 min atrás para agora');
  stop();
  await wait(1500);
  assert.equal(await beatOf(id), renewed, 'depois de encerrado, o sinal não é mais renovado');
});

test('m9d900 R4-L6: o intervalo do sinal de vida é parâmetro validado (1 a 600 s)', { skip: skip() }, async () => {
  assert.ok((await codeOf(setSetting(BEAT, 0))), '0 recusado');
  assert.ok((await codeOf(setSetting(BEAT, 601))), '601 recusado');
  assert.equal(await codeOf(setSetting(BEAT, 45)), null);
});
