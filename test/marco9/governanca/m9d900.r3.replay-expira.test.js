'use strict';

// M9-D900 (reabertura R3-L6 da rodada 3): o registro de controle de um replay interrompido (processo caído) não segura a vaga da fonte e da empresa por até 720 minutos.
// O replay é um lote só: expira no prazo próprio `migracao.execucao.expira_replay_min` (padrão 30), configurável; ao admitir o pedido seguinte, o registro vencido vira FAILED.
// A execução comum continua com `migracao.execucao.expira_min`. Banco descartável.

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { cleanMigrationSettings } = require('../_helpers/m9d900Clean');
const env = require('../_helpers/m9d900Env');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { admitReplay } = require('../../../src/features/migration-v2/ingest/run.admission');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const A = () => tenants.A;
const KEY = 'migracao.execucao.expira_replay_min';
const setSetting = (key, value) => env.openTenantTx(A(), (tx) => upsertSetting(key, value, A(), A().userId, tx));
const codeOf = (promise) => promise.then(() => null, (err) => err.code);
const admit = (system) => env.openTenantTx(A(), (tx) => admitReplay(A(), { userId: A().userId }, { sourceSystem: system, entity: 'PERSON' }, tx));
const insertTicket = async (system, kind, minutesAgo) => (await env.q(
  `INSERT INTO governance.mig_runs (group_id, company_id, source_system, entity, kind, status, started_at, requested_by)
   VALUES ($1, $2, $3, 'PERSON', $4, 'RUNNING', now() - make_interval(mins => $5::int), $6) RETURNING id`, [A().groupId, A().companyId, system, kind, minutesAgo, A().userId]))[0].id;
const statusOf = async (id) => (await env.q('SELECT status, error FROM governance.mig_runs WHERE id = $1', [id]))[0];

before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
afterEach(async () => {
  if (!env.DISPOSABLE) return;
  await setSetting(KEY, 30);
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status IN ('QUEUED', 'RUNNING', 'PAUSED')", [A().companyId]);
  await env.cleanMigration();
});
after(async () => { if (env.DISPOSABLE) await cleanMigrationSettings(); await env.sequelize.close(); });

test('m9d900 R3-L6: replay interrompido há mais que o prazo do replay deixa de segurar a vaga e vira FAILED', { skip: skip() }, async () => {
  const system = env.sysName();
  const stale = await insertTicket(system, 'REPLAY', 60);
  const ticket = await admit(system);
  assert.ok(ticket.id, 'um novo replay foi admitido');
  const row = await statusOf(stale);
  assert.equal(row.status, 'FAILED');
  assert.match(row.error, /interromp|expir/i);
});

test('m9d900 R3-L6: replay recente continua segurando a vaga (409), e o prazo é lido do parâmetro', { skip: skip() }, async () => {
  const system = env.sysName();
  await insertTicket(system, 'REPLAY', 10);
  assert.equal(await codeOf(admit(system)), 'GOV_MIG_RUN_ALREADY_ACTIVE');
  await setSetting(KEY, 5);
  assert.equal(await codeOf(admit(system)), null, 'com prazo de 5 min, o de 10 min venceu');
  await env.adminQuery("UPDATE governance.mig_runs SET status = 'FAILED', finished_at = now() WHERE company_id = $1 AND status = 'RUNNING'", [A().companyId]);
  await setSetting(KEY, 90);
  await insertTicket(system, 'REPLAY', 60);
  assert.equal(await codeOf(admit(system)), 'GOV_MIG_RUN_ALREADY_ACTIVE', 'com prazo de 90 min, o de 60 min ainda conta');
});

test('m9d900 R3-L6: execução comum parada há 60 min continua contando (prazo expira_min, 720)', { skip: skip() }, async () => {
  const system = env.sysName();
  const run = await insertTicket(system, 'RUN', 60);
  assert.equal(await codeOf(admit(system)), 'GOV_MIG_RUN_ALREADY_ACTIVE');
  assert.equal((await statusOf(run)).status, 'RUNNING', 'a execução comum não é encerrada por este prazo');
});
