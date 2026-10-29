'use strict';

// M9-D619 — o rebuild completo a partir das tabelas de origem (comando da M9-D608) reproduz o resultado incremental, com hash igual por empresa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d619Scenario');

let env;
let ids;
before(async () => {
  env = await bi.setup(sc.MODELS);
  ids = await sc.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

test('m9d619 rebuild reproduz o incremental', async () => {
  const tenant = env.tenantA;
  // a tabela foi apagada antes: há diferença, e a D608 exige o motivo
  const ctx = { groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason: 'Reconstrução após limpeza da tabela no teste da M9-D619.' };
  const hashes = {};
  for (const model of sc.MODELS) {
    hashes[model] = await asserts.assertRebuildEqualsIncremental({
      buildIncremental: () => sc.applyAll(tenant, ids),
      readRows: () => bi.rowsOf(env, model, tenant),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: tenant.companyId } }),
      rebuild: async () => {
        const out = await bi.readModels.rebuildReadModel(ctx, { model, companyId: tenant.companyId });
        assert.equal(out.status, 'SUCCEEDED', model);
      },
    });
  }
  assert.equal(Object.keys(hashes).length, 7);
  for (const h of Object.values(hashes)) assert.match(h, /^[0-9a-f]{64}$/);
});

test('m9d619 rebuild de cada read model declara a enumeração das chaves da fonte', () => {
  for (const model of sc.MODELS) assert.equal(typeof bi.readModels.getReadModel(model).rebuild.keys, 'function', model);
});
