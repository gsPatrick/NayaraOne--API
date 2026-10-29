'use strict';

// M9-D012 — ordem de decisão do ModelRouter: regra, cache, modelo pequeno, modelo avançado; determinismo; calcular_* nunca chama modelo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { CachePort } = require('../../../src/features/ai/providers/router/cachePort');
const { novoRoteador, entrada, tenantCtx, LIVRE, registroQueFalha } = require('../_helpers/iaRouter');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('m9d012_tarefa_de_regra_nao_chama_modelo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router, resolvers } = novoRoteador();
    let chamadas = 0;
    resolvers.register('contar_pendencias', async () => { chamadas += 1; return { total: 7 }; });
    const d = await router.decide(entrada({ taskType: 'contar_pendencias', budgetState: LIVRE }), tenantCtx(tenantA), tx);
    assert.equal(d.path, 'RULE');
    assert.equal(d.provider, null);
    assert.equal(d.model, null);
    assert.deepEqual(d.ruleResult, { total: 7 });
    assert.equal(d.reason, 'RULE_RESOLVER');
    assert.equal(chamadas, 1);
    // Resolvedor que não resolve (null) deixa a tarefa seguir para a ordem seguinte.
    resolvers.register('somar_inadimplencia', async () => null);
    const seguinte = await router.decide(entrada({ taskType: 'somar_inadimplencia', budgetState: LIVRE }), tenantCtx(tenantA), tx);
    assert.equal(seguinte.path, 'SMALL_MODEL');
  });
});

test('m9d012_calcular_sempre_regra_e_nunca_chama_modelo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // O registro de modelos falha se for consultado ou chamado: `calcular_*` nunca chega nele.
    const { router } = novoRoteador({ registry: registroQueFalha });
    // Mesmo sem resolvedor registrado, `calcular_*` sai pelo caminho RULE (forcedRoutingPath, M9-D026): o modelo não é candidato.
    const d = await router.decide(entrada({ taskType: 'calcular_inadimplencia', budgetState: LIVRE }), tenantCtx(tenantA), tx);
    assert.equal(d.path, 'RULE');
    assert.equal(d.reason, 'RULE_FORCED_CALCULATION');
    assert.equal(d.model, null);
    // Nem com orçamento esgotado: regra tem custo zero.
    const esgotado = { configured: true, state: 'EXHAUSTED', allowedPaths: ['RULE'] };
    assert.equal((await router.decide(entrada({ taskType: 'calcular_inadimplencia', budgetState: esgotado }), tenantCtx(tenantA), tx)).path, 'RULE');
  });
});

test('m9d012_ordem_regra_cache_pequeno_avancado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const cache = new CachePort();
    const { router, resolvers } = novoRoteador({ cache });
    cache.register(async (input) => (input.cacheKey === 'k1' ? { result: { texto: 'guardado' }, key: 'k1' } : null));
    resolvers.register('contar_pendencias', async () => ({ total: 1 }));
    const ctx = tenantCtx(tenantA);
    // 1. regra vence o cache.
    assert.equal((await router.decide(entrada({ taskType: 'contar_pendencias', cacheKey: 'k1', budgetState: LIVRE }), ctx, tx)).path, 'RULE');
    // 2. cache vence o modelo.
    const hit = await router.decide(entrada({ taskType: 'classificar', cacheKey: 'k1', budgetState: LIVRE }), ctx, tx);
    assert.equal(hit.path, 'CACHE');
    assert.deepEqual(hit.cacheResult, { texto: 'guardado' });
    assert.equal(hit.model, null);
    // 3. sem hit: pequeno para classificação, avançado para comparação.
    assert.equal((await router.decide(entrada({ taskType: 'classificar', cacheKey: 'k2', budgetState: LIVRE }), ctx, tx)).path, 'SMALL_MODEL');
    assert.equal((await router.decide(entrada({ taskType: 'comparar_documentos', cacheKey: 'k2', budgetState: LIVRE }), ctx, tx)).path, 'ADVANCED_MODEL');
  });
});

test('m9d012_decisao_deterministica', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    const ctx = tenantCtx(tenantA);
    const entradas = [entrada({ taskType: 'classificar', budgetState: LIVRE }), entrada({ taskType: 'minuta_juridica', budgetState: LIVRE }), entrada({ taskType: 'conversar', inputSize: 5000, budgetState: LIVRE })];
    for (const e of entradas) {
      const primeira = await router.decide(e, ctx, tx);
      for (let i = 0; i < 4; i += 1) assert.deepEqual(await router.decide(e, ctx, tx), primeira);
    }
  });
});
