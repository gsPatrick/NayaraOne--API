'use strict';

// M9-D901 — ponto de extensão dos blockers (3.3 e, f, i): um provedor registrado abre blocker na Torre e, ao deixar de devolver a condição, o blocker fecha. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');
const providers = require('../../../src/features/migration-v2/control/blockers.providers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d901 provedor registrado abre e fecha blocker na Torre', { skip: skip() }, async () => {
  const A = tenants.A;
  const legacy = await env.installSource(A, { entity: 'PERSON' });
  await env.seedRecords(A, legacy.system, 'PERSON', { MIGRATED: 2 });
  const runId = await env.newRun(A, legacy.system, 'PERSON');
  let open = true;
  const off = providers.register('m9d901-teste', async () => (open ? [{ code: 'GOV_MIG_TESTE_EXTERNO', entity: null, ref: 'dif-1', owner: null, detail: { motivo: 'condição de outra demanda' } }] : []));
  try {
    const opened = await env.getTower(A, runId);
    assert.ok(opened.blockers.some((b) => b.code === 'GOV_MIG_TESTE_EXTERNO' && b.ref === 'dif-1'), 'o blocker do provedor aparece');
    open = false;
    const closed = await env.getTower(A, runId);
    assert.ok(!closed.blockers.some((b) => b.code === 'GOV_MIG_TESTE_EXTERNO'), 'o blocker some quando a condição acaba');
  } finally { off(); }
  const after2 = await env.getTower(A, runId);
  assert.ok(!after2.blockers.some((b) => b.code === 'GOV_MIG_TESTE_EXTERNO'));
  assert.throws(() => providers.register('x', 'nao-funcao'), /função/);
  legacy.dispose();
});
