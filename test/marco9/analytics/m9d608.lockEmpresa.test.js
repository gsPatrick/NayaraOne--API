'use strict';

// M9-D608 (reabertura L-2) — o lock do rebuild é por empresa e modelo: a empresa B reconstrói enquanto a A está no meio, cada uma com a sua
// tabela sombra; a mesma empresa continua recebendo 409. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env608 = require('../_helpers/m9d608Env');
const readModels = require('../../../src/features/analytics/read-models');

const { addSource, applyCommitted, shadowExists, shadowOf, ctxFor } = env608;
let env;

before(async () => {
  env = await env608.setup();
  await addSource(env, env.tenantA, 'caixa', '10.00');
  await applyCommitted(env, env.tenantA, 'caixa');
  await addSource(env, env.tenantB, 'caixa', '20.00');
  await applyCommitted(env, env.tenantB, 'caixa');
});
after(() => env608.teardown(env));

const run = (tenant, hooks) => readModels.rebuildReadModel(ctxFor(tenant, { reason: 'lock por empresa' }), { model: env.model, companyId: tenant.companyId, hooks });

test('m9d608 rebuild da empresa A não trava a empresa B, e a mesma empresa segue com 409', async () => {
  let reached;
  let release;
  const paused = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run(env.tenantA, { afterShadow: async () => { reached(); await gate; } });
  await paused;
  try {
    assert.equal(await shadowExists(env, env.tenantA), true, 'A está com a sombra pronta');
    assert.notEqual(shadowOf(env, env.tenantA), shadowOf(env, env.tenantB), 'cada empresa tem a sua sombra');
    await assert.rejects(run(env.tenantA), (e) => e.statusCode === 409 && e.code === 'ANALYTICS_REBUILD_IN_PROGRESS');
    const other = await run(env.tenantB);
    assert.equal(other.status, 'SUCCEEDED', 'B reconstrói enquanto A está em andamento');
    assert.equal(await shadowExists(env, env.tenantB), false, 'a sombra de B foi descartada');
    assert.equal(await shadowExists(env, env.tenantA), true, 'a sombra de A não foi tocada pelo rebuild de B');
  } finally {
    release();
  }
  assert.equal((await first).status, 'SUCCEEDED');
  assert.equal(await shadowExists(env, env.tenantA), false);
});
