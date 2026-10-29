'use strict';

// M9-D618 — o rebuild completo a partir das tabelas de origem (comando da M9-D608) reproduz o resultado incremental, com hash igual por empresa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d618Scenario');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
  await bi.seed(env, env.tenantA, 'construction.projects', { name: 'Obra sem nada', status: 'PLANNED' }); // sem etapa, sem custo: ainda assim tem estado
});
after(() => bi.teardown(env));

const ctx = { groupId: null, actorUserId: null, permissions: ['analytics:rebuild'], reason: null };

test('m9d618 rebuild reproduz o incremental', async () => {
  const tenant = env.tenantA;
  // a tabela foi apagada antes: há diferença, e a D608 exige o motivo
  const rebuildCtx = { ...ctx, groupId: tenant.groupId, actorUserId: tenant.userId, reason: 'Reconstrução após limpeza da tabela no teste da M9-D618.' };
  // o evento project.created da obra sem nada entra no incremental como entraria em produção
  const lone = (await env.admin.query("SELECT id FROM construction.projects WHERE company_id = :c AND name = 'Obra sem nada'", { replacements: { c: tenant.companyId } }))[0][0].id;
  const hashes = {};
  for (const model of sc.MODELS) {
    hashes[model] = await asserts.assertRebuildEqualsIncremental({
      buildIncremental: async () => {
        // reaplica TODOS os eventos do cenário (idempotente por evento novo): o estado de cada agregado vem da fonte
        await sc.applyAll(tenant, ids);
        await bi.apply(tenant, bi.makeEvent(tenant, 'project.created', { id: lone }));
      },
      readRows: () => bi.rowsOf(env, model, tenant),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: tenant.companyId } }),
      rebuild: async () => {
        const out = await bi.readModels.rebuildReadModel(rebuildCtx, { model, companyId: tenant.companyId });
        assert.equal(out.status, 'SUCCEEDED', model);
      },
    });
  }
  assert.equal(Object.keys(hashes).length, 9);
  for (const h of Object.values(hashes)) assert.match(h, /^[0-9a-f]{64}$/);
});

test('m9d618 rebuild de cada read model declara a enumeração das chaves da fonte', () => {
  for (const model of sc.MODELS) {
    const def = bi.readModels.getReadModel(model);
    assert.equal(typeof def.rebuild.keys, 'function', model);
    assert.ok(Array.isArray(def.aggregateColumns), model);
  }
});
