'use strict';

// M9-D650 / M9-D651 — os seis KPIs de Obras se atualizam sozinhos: ao fim do lote de refresh de qualquer read model de Obras (uma vez por empresa e
// transação) e pelo snapshot diário (só para hoje: os read models de Obras não guardam histórico por data-base).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d650Scenario');
const { onFlushed } = require('../../../src/features/analytics/metrics/kpis/obras/listener');
const { provider } = require('../../../src/features/analytics/metrics/kpis/obras/snapshotProvider');
const { KPI_DEFINITIONS } = require('../../../src/features/analytics/metrics/kpis/obras/definitions');
const { listSnapshotProviders } = require('../../../src/features/analytics/metrics/snapshots.providers');
require('../../../src/features/analytics');

let env;
before(async () => {
  env = await bi.setup();
  const aurora = await scenario.seedAurora(env, env.tenantA);
  const bela = await scenario.seedBela(env, env.tenantA);
  await bi.refresh(env.tenantA, [aurora, bela]); // só os read models: os KPIs ainda não foram calculados
});
after(() => bi.teardown(env));

const codes = () => KPI_DEFINITIONS.map((d) => d.metricCode).sort();
const snapshotsOf = async (t) => (await env.admin.query(
  "SELECT d.metric_code, count(*)::int AS n FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id WHERE s.company_id = :c AND d.metric_code LIKE 'obra.%' GROUP BY 1 ORDER BY 1", { replacements: { c: t.companyId } }
))[0];

test('m9d650 o gancho de fim de lote calcula os KPIs de Obras uma vez por empresa e transação e ignora read model de outro domínio', async () => {
  assert.deepEqual(await snapshotsOf(env.tenantA), [], 'antes do lote não há snapshot');
  await bi.inTx(env.tenantA, { commit: true }, async (tx) => {
    await onFlushed({ readModel: 'rm_finance_health', companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, tx);
    await onFlushed({ readModel: 'rm_project_cost', companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, tx);
    await onFlushed({ readModel: 'rm_project_progress', companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, tx); // mesmo lote: não repete
  });
  const rows = await snapshotsOf(env.tenantA);
  assert.deepEqual(rows.map((r) => r.metric_code), codes(), 'um snapshot de cada KPI de Obras publicado');
  const forecast = await bi.readKpi(env.tenantA, 'obra.baseline_actual_forecast');
  assert.equal(forecast.status, 'OK');
  assert.equal(forecast.asOfDate, bi.AS_OF, 'a data-base é a de hoje em São Paulo, do relógio do BI');
});

test('m9d650 o snapshot diário calcula os mesmos KPIs pelo provedor registrado, só para hoje', async () => {
  assert.ok(listSnapshotProviders().some((p) => p.name === 'obras-kpis'), 'o provedor está registrado');
  assert.deepEqual([...provider.metricCodes].sort(), codes());
  await bi.inTx(env.tenantA, { commit: true }, async (tx) => {
    const scope = { companyId: env.tenantA.companyId, groupId: env.tenantA.groupId };
    const today = await provider.build(scope, bi.AS_OF, tx);
    assert.deepEqual(today.map((e) => e.code).sort(), codes());
    assert.ok(today.every((e) => e.inputs[0].dimensionKey === '' && e.inputs[0].sourceRefs.length === 1), 'valor principal e rastreio em todos');
    assert.deepEqual(await provider.build(scope, '2026-10-20', tx), [], 'dia passado: o estado daquela data não existe mais e nada é inventado');
  });
});
