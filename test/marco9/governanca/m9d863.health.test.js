'use strict';

// M9-D863 — GET /finops/health: status, faturado x estimado separados, coletor parado (STALE) e degradações (banco descartável).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d863Env');
const logger = require('../../../src/utils/logger');
const { getOverview } = require('../../../src/features/core-governance/finops/finops.service');
const { runCollector } = require('../../../src/features/core-governance/finops/collectors/run');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const itemOf = (h, budgetId) => h.ambientes.flatMap((a) => a.dominios).find((d) => d.orcamentoId === budgetId);
const health = (tx, now) => getOverview(tenants.A, tx, { includeShared: true, now });

test('m9d863 health separa faturado e estimado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.spend(A, tx, 100000);
    await env.spend(A, tx, 50000, { costKind: 'BILLED' });
    const item = itemOf(await health(tx), budget.id);
    assert.equal(item.consumo.estimado.totalCentavos, 100000);
    assert.equal(item.consumo.faturado.totalCentavos, 50000);
    assert.equal(item.consumo.consumidoCentavos, 100000, 'o percentual usa a série-base, sem somar as duas');
    assert.equal(item.percentual, 33);
    assert.equal(item.orcamentoCentavos, 300000);
    assert.equal(item.limiarAtual, null);
    assert.equal(item.status, 'OK');
  });
});

test('m9d863 health traz status por ambiente e domínio e o geral é o pior', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.mkBudget(A, tx, { environment: 'PROD', amountCents: 400000 });
    await env.mkBudget(A, tx, { environment: 'DEV', domain: 'FISCAL', amountCents: 100000 });
    await env.spend(A, tx, 320000, { environment: 'PROD' }); // PROD 80%
    await env.spend(A, tx, 120000, { environment: 'DEV', domain: 'FISCAL' }); // DEV/FISCAL 120%
    const h = await health(tx);
    const by = Object.fromEntries(h.ambientes.map((a) => [a.ambiente, a]));
    assert.deepEqual([by.PROD.status, by.PROD.dominios[0].limiarAtual, by.DEV.status, by.DEV.dominios[0].limiarAtual], ['ATTENTION', 75, 'CRITICAL', 100]);
    assert.equal(h.status, 'CRITICAL', 'o geral é o pior entre todos');
    for (const key of ['orcamentos', 'achados', 'detectores', 'custos', 'collectors', 'achadosPorDetector', 'degradacoes']) assert.ok(key in h, key);
  });
});

test('m9d863 health com coletor parado marca STALE e avisa que o percentual pode estar incompleto', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const budget = await env.mkBudget(A, tx);
    await env.spend(A, tx, 30000);
    const okAt = new Date(Date.now() - 3600000);
    await runCollector(A, 'storage', async () => 3, tx, okAt);
    assert.equal((await health(tx)).collectors.find((c) => c.collector === 'storage').state, 'OK');
    const failedAt = new Date();
    const prev = logger.level;
    logger.level = 'silent';
    try { await runCollector(A, 'storage', async () => { throw new Error('boom'); }, tx, failedAt); } finally { logger.level = prev; }
    const h = await health(tx);
    const storage = h.collectors.find((c) => c.collector === 'storage');
    assert.equal(storage.state, 'STALE');
    assert.equal(storage.lastDataAt, okAt.toISOString(), 'mostra a hora do último dado bom');
    assert.equal(storage.lastErrorCode, 'GOV_FINOPS_COLLECTOR_FAILED');
    const item = itemOf(h, budget.id);
    assert.equal(item.dadoIncompleto, true);
    assert.match(item.aviso, /storage.*incompleto/);
  });
});

test('m9d863 STALE aparece em collectors e não no status geral', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.mkBudget(A, tx);
    const prev = logger.level;
    logger.level = 'silent';
    try { await runCollector(A, 'egress', async () => { throw new Error('boom'); }, tx, new Date()); } finally { logger.level = prev; }
    const h = await health(tx);
    assert.equal(h.collectors.find((c) => c.collector === 'egress').state, 'STALE');
    assert.ok(['OK', 'ATTENTION', 'CRITICAL'].includes(h.status), 'o status só tem OK, ATTENTION e CRITICAL');
    assert.equal(h.status, 'OK');
    assert.ok(h.ambientes.every((a) => a.status !== 'STALE' && a.dominios.every((d) => d.status !== 'STALE')));
  });
});

test('m9d863 health lista as degradações aplicadas', { skip: skip() }, async () => {
  const level = logger.level;
  try {
    await run(async (tx) => {
      const A = tenants.A;
      const budget = await env.mkBudget(A, tx);
      await env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }] });
      await env.spend(A, tx, 285000);
      await env.degrade(A, tx);
      const h = await health(tx);
      assert.equal(h.degradacoes.length, 1);
      assert.deepEqual([h.degradacoes[0].passo, h.degradacoes[0].situacao, h.degradacoes[0].ambiente, h.degradacoes[0].limiar], ['LIMIT_EXPORT_SIZE', 'APPLIED', 'PROD', 90]);
    });
  } finally { logger.level = level; }
});
