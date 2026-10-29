'use strict';

// M9-D628 — o rebuild completo a partir das tabelas de origem (comando da M9-D608) reproduz o resultado incremental, com hash igual por empresa, em cada um dos nove read models.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const asserts = require('../_helpers/readModelAsserts');
const sc = require('../_helpers/m9d628Scenario');

let env;
let ids;
before(async () => {
  env = await env628.setup();
  ids = await sc.seedAll(env, env.tenantA);
});
after(() => env628.teardown(env));

test('m9d628 rebuild reproduz o incremental', async () => {
  const tenant = env.tenantA;
  const ctx = { groupId: tenant.groupId, actorUserId: tenant.userId, permissions: ['analytics:rebuild'], reason: 'Reconstrução após limpeza da tabela no teste da M9-D628.' };
  const hashes = {};
  for (const model of sc.MODELS) {
    hashes[model] = await asserts.assertRebuildEqualsIncremental({
      buildIncremental: () => sc.applyAll(env, tenant, ids),
      readRows: () => env628.rowsOf(env, model, tenant),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: tenant.companyId } }),
      rebuild: async () => {
        const out = await env628.readModels.rebuildReadModel(ctx, { model, companyId: tenant.companyId });
        assert.equal(out.status, 'SUCCEEDED', model);
      },
    });
  }
  assert.equal(Object.keys(hashes).length, 9);
  for (const h of Object.values(hashes)) assert.match(h, /^[0-9a-f]{64}$/);
});

test('m9d628 o rebuild de cada read model declara a enumeração das chaves da fonte', () => {
  for (const model of sc.MODELS) assert.equal(typeof env628.readModels.getReadModel(model).rebuild.keys, 'function', model);
});
