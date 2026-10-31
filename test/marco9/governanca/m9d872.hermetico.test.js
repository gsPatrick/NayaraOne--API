'use strict';

// M9-D872 — hermetismo dos testes do kill switch: um switch COMMITADO por outro teste (probe que só existia na memória de outro processo)
// não pode derrubar o ciclo; a limpeza o remove e o ciclo roda só com os switches do próprio teste (banco descartável).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d872.hermetico.test.js"

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d872Env');
const { purgeKillSwitchResidue, plantKillSwitch } = require('../_helpers/killSwitchResidue');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const STRAY = 'qa.contrato.residuo_hermetico';
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
beforeEach(() => { env.registerTestProbe('1'); env.behavior.calls = 0; });
after(async () => { if (env.DISPOSABLE) await purgeKillSwitchResidue([STRAY]); await env.sequelize.close(); });

const plantStray = async (tenant) => { await purgeKillSwitchResidue([STRAY]); await plantKillSwitch(tenant, STRAY); };

test('m9d872 a limpeza remove o kill switch commitado por outro teste e o ciclo não tropeça nele', { skip: skip() }, async () => {
  const A = tenants.A;
  await plantStray(A);
  assert.equal(await purgeKillSwitchResidue([STRAY]), 1);
  assert.equal((await env.adminQuery('SELECT 1 FROM governance.feature_flags WHERE key = $1', [STRAY])).rowCount, 0);
  const own = await env.withRollbackTenantTransaction(A, async (tx) => {
    const sw = await env.mkSwitch(A, tx);
    env.behavior.run = async () => ({ pass: true });
    const result = await env.cycle.runCycle(A, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
    return { key: sw.key, drills: result.drills.map((d) => [d.key, d.result]) };
  });
  assert.deepEqual(own.drills, [[own.key, 'PASS']]);
});

test('m9d872 sem a limpeza, o resíduo é o que quebra o ciclo (prova de que o defeito era real)', { skip: skip() }, async () => {
  const A = tenants.A;
  await plantStray(A);
  try {
    await assert.rejects(
      env.withRollbackTenantTransaction(A, async (tx) => {
        await env.mkSwitch(A, tx);
        env.behavior.run = async () => ({ pass: true });
        return env.cycle.runCycle(A, { environment: 'HOMOLOG', now: env.NOW, transaction: tx });
      }),
      (err) => err.code === 'GOV_KILL_PROBE_REQUIRED' || /probe/i.test(err.message),
    );
  } finally { await purgeKillSwitchResidue([STRAY]); }
});
