'use strict';

// M9-D611 (BI-003) — toda métrica devolve sourceRefs; sem permissão os ids não vazam; KPI composto expõe componentes; filterHash assinado.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env611 = require('../_helpers/m9d611Env');
const registry = require('../../../src/features/analytics/metrics');
const store = require('../../../src/features/analytics/metricStore.service');

const { FAMILIES, filterOf, ctxFor, inTx, ctxOf, metricInput } = env611;
let env;
let catalog;
before(async () => {
  env = await env611.setup();
  for (const f of FAMILIES) {
    fs.writeFileSync(path.join(env.formulaDir, `${f.key}.js`), `module.exports = { id: '${f.code.replace('.', '_')}_f', version: 1, compute: () => ({ value: '1' }), testCases: [{ name: 'um', input: [], expected: { value: '1' } }] };`);
  }
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(() => env611.teardown(env));

const inA = (fn) => inTx(env.tenantA, {}, fn);
const HEX64 = /^[0-9a-f]{64}$/;

test('m9d611 toda métrica seed devolve sourceRefs', async () => {
  await inA(async (tx) => {
    for (const f of FAMILIES) {
      const ctx = await ctxFor(env, f, {}, tx);
      const { definition, version } = await registry.publishMetric(metricInput(env, { metricCode: f.code, formulaId: `${f.code.replace('.', '_')}_f`, unit: f.unit, valueNature: 'ACTUAL' }), { ...ctxOf(env.tenantA) }, tx, { catalog });
      const { sourceRefs } = await registry.buildSourceRefs(ctx, f.code, { filter: filterOf(f) }, tx);
      assert.equal(sourceRefs.length, 1, f.code);
      const [ref] = sourceRefs;
      assert.match(ref.filterHash, HEX64);
      assert.match(ref.filterSignature, HEX64, 'o hash vai assinado');
      assert.equal(ref.count, f.inside.length);
      assert.ok(ref.idsSample.length > 0 && ref.idsSample.length <= 20);
      assert.equal(typeof ref.description, 'string');
      assert.equal(ref.table, `analytics.${env611.tableOf(env, f)}`);
      await store.enableAnalyticsWriter(tx);
      await store.recordSnapshot({
        companyId: env.tenantA.companyId, groupId: env.tenantA.groupId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: env.tenantA.companyId,
        periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate: '2026-10-28', valueNumeric: '1', status: 'OK', sourceSnapshotAt: new Date(), sourceRefs,
        calcHash: registry.calcHash({ metricCode: f.code, version: 1, inputs: [], params: {} }),
      }, tx);
      const read = await registry.readMetricValue(ctx, { metricCode: f.code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-10-28' }, tx);
      assert.equal(read.sourceRefs[0].filterHash, ref.filterHash, 'a leitura do valor devolve o mesmo sourceRefs');
      assert.equal(read.sourceRefs[0].count, f.inside.length);
    }
  });
});

test('m9d611 sem permissão idsSample vazio e restricted=true', async () => {
  const f = FAMILIES[0];
  await inA(async (tx) => {
    const withDetail = (await registry.buildSourceRefs(await ctxFor(env, f, {}, tx), f.code, { filter: filterOf(f), unit: f.unit }, tx)).sourceRefs[0];
    const noDetail = (await registry.buildSourceRefs(await ctxFor(env, f, { detail: false }, tx), f.code, { filter: filterOf(f), unit: f.unit }, tx)).sourceRefs[0];
    assert.equal(withDetail.restricted, false);
    assert.equal(withDetail.idsSample.length, f.inside.length);
    assert.equal(noDetail.restricted, true);
    assert.deepEqual(noDetail.idsSample, []);
    assert.equal(noDetail.count, withDetail.count, 'o agregado continua visível');
    assert.equal(noDetail.filterHash, withDetail.filterHash);
    // só a permissão de detalhe sem a leitura da área também não mostra ids
    const ctx = { ...(await ctxFor(env, f, { detail: false }, tx)), permissions: ['analytics:read', 'analytics:drilldown'] };
    assert.deepEqual((await registry.buildSourceRefs(ctx, f.code, { filter: filterOf(f), unit: f.unit }, tx)).sourceRefs[0].idsSample, []);
  });
});

test('m9d611 KPI composto expõe componentes', async () => {
  const [a, b] = [FAMILIES[0], FAMILIES[2]];
  const composite = `fin.m9d611_composto_${env.sfx}`;
  registry.registerSourceSpec({ metricCode: composite, components: [a.code, b.code] });
  try {
    await inA(async (tx) => {
      const out = await registry.buildSourceRefs(await ctxFor(env, a, {}, tx), composite, { componentFilters: { [a.code]: filterOf(a), [b.code]: filterOf(b) }, units: { [a.code]: a.unit, [b.code]: b.unit }, domain: 'FINANCE' }, tx);
      assert.deepEqual(out.components.map((c) => c.metricCode), [a.code, b.code]);
      assert.ok(out.components.every((c) => c.sourceRefs.length === 1 && HEX64.test(c.sourceRefs[0].filterHash)));
      assert.equal(out.sourceRefs.length, 2, 'a lista principal reúne as referências dos componentes');
      assert.equal(out.reconcileMode, 'COMPOSITE');
    });
  } finally { registry.unregisterSourceSpec(composite); }
});

test('m9d611 indicador sem origem declarada é recusado', async () => {
  await inA(async (tx) => {
    await assert.rejects(registry.buildSourceRefs(await ctxFor(env, FAMILIES[0], {}, tx), 'fin.m9d611_nao_existe', { filter: {} }, tx), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_SOURCE_SPEC_MISSING');
  });
});
