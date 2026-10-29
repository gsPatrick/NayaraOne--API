'use strict';

// M9-D611 (BI-003) — reconciliação do detalhe por filterHash com o valor do KPI, no modo do tipo (SUM, COUNT ou RECOMPUTE), nas 11 famílias.
// Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env611 = require('../_helpers/m9d611Env');
const registry = require('../../../src/features/analytics/metrics');

const { FAMILIES, filterOf, ctxFor, inTx } = env611;
let env;
before(async () => { env = await env611.setup(); });
after(() => env611.teardown(env));

const inA = (fn) => inTx(env.tenantA, {}, fn);

test('m9d611 reconciliação do detalhe por filterHash iguala o valor do KPI', async () => {
  assert.equal(FAMILIES.length, 11, 'uma família para cada valor do enum domain');
  assert.deepEqual(FAMILIES.map((f) => f.domain).sort(), [...require('../../../src/features/analytics/metricStore.service').DOMAINS].filter((d) => d !== 'GENERAL').sort());
  await inA(async (tx) => {
    for (const f of FAMILIES) {
      const ctx = await ctxFor(env, f, {}, tx);
      const kpi = f.expected(f.inside);
      const out = await registry.buildSourceRefs(ctx, f.code, { filter: filterOf(f), unit: f.unit }, tx);
      const [ref] = out.sourceRefs;
      assert.equal(out.reconcileMode, f.mode, `${f.domain}: modo do tipo ${f.unit}`);
      assert.equal(ref.count, f.inside.length, `${f.domain}: count = linhas do filtro (ruído de outra empresa, status e período fora)`);
      const r = await registry.reconcileDetail(ctx, f.code, ref, kpi, { unit: f.unit, catalog: env.catalog, asOfDate: '2026-10-28' }, tx);
      assert.equal(r.mode, f.mode);
      assert.equal(r.detail, kpi, `${f.domain}: o detalhe refeito dá exatamente o valor do KPI (mesmas casas)`);
      assert.equal(r.ok, true);
      await registry.assertReconciles(ctx, f.code, ref, kpi, { unit: f.unit, catalog: env.catalog, asOfDate: '2026-10-28' }, tx);
    }
  });
});

test('m9d611 KPI de média, taxa e tempo reconcilia pelo modo RECOMPUTE', async () => {
  const wanted = ['crm.first_response_time_m9d611', 'tec.availability_m9d611', 'cor.analysis_time_m9d611'];
  await inA(async (tx) => {
    for (const code of wanted) {
      const f = FAMILIES.find((x) => x.code === code);
      const ctx = await ctxFor(env, f, {}, tx);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: filterOf(f), unit: f.unit }, tx);
      assert.equal(reconcileMode, 'RECOMPUTE', `${code}: média, taxa e tempo não somam, refazem a fórmula`);
      const ok = await registry.reconcileDetail(ctx, code, ref, f.expected(f.inside), { unit: f.unit, catalog: env.catalog, asOfDate: '2026-10-28' }, tx);
      assert.equal(ok.ok, true, `${code}: ${ok.detail} x ${ok.kpi}`);
      // somar o campo do detalhe NÃO dá o valor da média/taxa (por isso o modo SUM não vale aqui)
      const wrong = await registry.reconcileDetail(ctx, code, ref, '999.99', { unit: f.unit, catalog: env.catalog, asOfDate: '2026-10-28' }, tx);
      assert.equal(wrong.ok, false);
      await assert.rejects(registry.assertReconciles(ctx, code, ref, '999.99', { unit: f.unit, catalog: env.catalog, asOfDate: '2026-10-28' }, tx), (e) => e.code === 'ANALYTICS_RECONCILIATION_FAILED');
    }
  });
});

test('m9d611 modo derivado da unidade e BRL_PER_UNIT por soma', () => {
  const m = registry.reconcileModeForUnit;
  assert.deepEqual(['BRL', 'BRL_PER_UNIT'].map(m), ['SUM', 'SUM']);
  assert.equal(m('COUNT'), 'COUNT');
  for (const u of ['PERCENT', 'PP', 'SCORE', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'NUMBER']) assert.equal(m(u), 'RECOMPUTE', u);
});
