'use strict';

// M9-D907 (reabertura L6) — a prontidão do GO não depende de efeito colateral de import: o GO carrega as verificações obrigatórias e, sem uma delas, recusa. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const env = require('../_helpers/m9d907Env');
const readiness = require('../../../src/features/migration-v2/rollback/readiness');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { await env.sequelize.close(); });

test('m9d907 processo novo que importa só o serviço do corte já tem a verificação do DRY3 carregada', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const script = "const r = require('./src/features/migration-v2/rollback/readiness'); require('./src/features/migration-v2/rollback/cutover.service'); const before = r.registeredNames(); r.loadRequired(); console.log(JSON.stringify({ before, after: r.registeredNames() }));";
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, LOG_LEVEL: 'silent' } }).toString().trim().split('\n').pop());
  assert.deepEqual(out.before, [], 'sem efeito colateral de import, nada está registrado antes');
  assert.deepEqual(out.after, readiness.REQUIRED_CHECKS, 'loadRequired registra a simulação de rollback do DRY3');
});

test('m9d907 GO com a verificação obrigatória fora do registro é recusado (falha fechada) e volta a valer quando ela é registrada', { skip: skip() }, async () => {
  await env.listTypes(A);
  await env.markRollbackSimulated(A, true);
  readiness.loadRequired();
  const saved = readiness.unregister('dry3-rollback-simulation');
  const hook = require('../../../src/features/migration-v2/dryrun/dry.readiness');
  const realInstall = hook.install;
  hook.install = () => {}; // o carregador não consegue recolocá-la, como num ambiente em que o módulo da verificação não registra
  try {
    const blocked = await env.fail(env.decide(A, 'GO'));
    assert.deepEqual([blocked.status, blocked.code], [409, 'GOV_CUTOVER_NOT_READY']);
    assert.deepEqual(blocked.details.gaps.map((g) => [g.code, g.detail.check]), [[readiness.MISSING, 'dry3-rollback-simulation']]);
    assert.equal((await env.adminQuery('SELECT 1 FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows.length, 0);
  } finally {
    hook.install = realInstall;
    readiness.register('dry3-rollback-simulation', saved);
  }
  assert.equal((await env.decide(A, 'GO')).decision, 'GO');
});
