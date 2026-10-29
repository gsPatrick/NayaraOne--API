'use strict';

// M9-D697 (§18) — quem lê a qualidade: faixa do painel, adiamento da conclusão de bloco do Centro de Comando, item ATENCAO_QUALIDADE da NAY,
// alerta que não dispara sobre dado ruim e exportação que recusa métrica degradada. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d697Env');
const { composeWidgets } = require('../../../src/features/analytics/dashboards/dashboard.compose');
const { loadAlertInput } = require('../../../src/features/analytics/alerts/engine.snapshot');
const quality = require('../../../src/features/analytics/quality');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const ctx = () => ({ companyId: tenant.companyId, groupId: tenant.groupId, actorUserId: tenant.userId, permissions: e.PERMS, rowScope: { mode: 'ALL', userIds: [] } });
const row = (position, widget_type, extra = {}) => ({ position, widget_type, metric_code: null, dimension_key: '', title: `w${position}`, value_nature: 'ACTUAL', drilldown_enabled: false, config: {}, ...extra });

test('m9d697 faixa de qualidade lista as degradadas antes dos números', async () => {
  const ruim = await e.freshMetric(env, tenant);
  const boa = await e.freshMetric(env, tenant);
  await e.recordCheck(tenant, { metrics: [ruim.code] });
  const widgets = [row(0, 'QUALITY_BANNER'), row(1, 'KPI_CARD', { metric_code: ruim.code }), row(2, 'KPI_CARD', { metric_code: boa.code })];
  const out = await e.inTx(tenant, {}, (tx) => composeWidgets(ctx(), widgets, e.TODAY, tx));
  assert.equal(out.widgets[0].type, 'QUALITY_BANNER');
  assert.deepEqual(out.widgets[0].banner.degradedMetrics.map((d) => [d.metricCode, d.problem]), [[ruim.code, 'DEGRADED']]);
  const card = out.widgets[1].metric;
  assert.deepEqual([card.value, card.formatted, card.incomplete, card.incompleteText, card.valueReliable], [null, null, true, 'Dado incompleto', false]);
  assert.equal(card.quality.degradedBy[0].checkCode, 'recon_saldo', 'o cartão traz a lista de checks que reprovaram');
  assert.equal(out.widgets[2].metric.incomplete, false);
});

test('m9d697 Centro de Comando adia conclusão de bloco com dado ruim', async () => {
  const ruim = await e.freshMetric(env, tenant);
  const boa = await e.freshMetric(env, tenant);
  const velha = await e.freshMetric(env, tenant, { ageMinutes: 120 });
  await e.recordCheck(tenant, { metrics: [ruim.code] });
  const widgets = [
    row(0, 'QUALITY_BANNER'),
    row(1, 'LIST_ALERTS', { title: 'Onde há dinheiro parado', config: { dependsOn: [ruim.code, boa.code] } }),
    row(2, 'LIST_ALERTS', { title: 'Quais prazos estão críticos', config: { dependsOn: [boa.code] } }),
    row(3, 'LIST_ALERTS', { title: 'Onde há risco', config: { dependsOn: [velha.code] } }),
  ];
  const out = await e.inTx(tenant, {}, (tx) => composeWidgets(ctx(), widgets, e.TODAY, tx));
  const [, parado, prazos, risco] = out.widgets;
  assert.deepEqual([parado.block.deferred, parado.block.text], [true, 'Conclusão adiada: dado incompleto']);
  assert.deepEqual(parado.block.reasons.map((r) => [r.metricCode, r.problem]), [[ruim.code, 'DEGRADED']]);
  assert.deepEqual([prazos.block.deferred, prazos.block.text, prazos.block.reasons], [false, null, []]);
  assert.equal(risco.block.deferred, true, 'STALE também adia (a conclusão não se apoia em dado desatualizado)');
  assert.equal(risco.block.reasons[0].problem, 'STALE');
  assert.deepEqual(out.widgets[0].banner.degradedMetrics.map((d) => d.metricCode).sort(), [ruim.code, velha.code].sort());
});

test('m9d697 bloco cujo indicador não tem registro também adia a conclusão', async () => {
  const gate = await e.inTx(tenant, {}, (tx) => quality.evaluateBlock(ctx(), ['fin.nao_existe_m9d697'], e.TODAY, tx));
  assert.equal(gate.deferred, true);
  assert.equal(gate.reasons[0].problem, 'INCOMPLETE');
});

test('m9d697 NAY não conclui sobre área degradada', async () => {
  const ruim = await e.freshMetric(env, tenant);
  await e.recordCheck(tenant, { metrics: [ruim.code] });
  const gate = await e.inTx(tenant, {}, (tx) => quality.evaluateBlock(ctx(), [ruim.code], e.TODAY, tx));
  assert.equal(gate.concludes, false);
  const item = quality.qualityAttentionItem({ area: 'Financeiro', gate });
  assert.equal(item.tipo, 'ATENCAO_QUALIDADE');
  assert.equal(item.area, 'Financeiro');
  assert.match(item.fato, /Financeiro/);
  assert.match(item.fato, /dado incompleto/i);
  assert.deepEqual(item.metricCodes, [ruim.code]);
  assert.equal(JSON.stringify(item).includes('100.0000'), false, 'sem número da métrica ruim');
  const ok = await e.freshMetric(env, tenant);
  const good = await e.inTx(tenant, {}, (tx) => quality.evaluateBlock(ctx(), [ok.code], e.TODAY, tx));
  assert.equal(good.concludes, true);
  assert.equal(quality.qualityAttentionItem({ area: 'Financeiro', gate: good }), null);
});

test('m9d697 alerta não dispara sobre valor degradado', async () => {
  const m = await e.freshMetric(env, tenant);
  const def = { metric_code: m.code, scope: {}, metric_version_pin: null };
  const scope = { companyId: tenant.companyId, groupId: tenant.groupId };
  const run = () => e.inTx(tenant, {}, (tx) => loadAlertInput(def, scope, { now: new Date(e.NOW) }, tx));
  assert.equal((await run()).hold, undefined, 'dado bom avalia normalmente');
  await e.recordCheck(tenant, { metrics: [m.code] });
  const held = await run();
  assert.equal(held.hold, 'DEGRADED', 'check BLOCK falho: a definição fica em espera');
  assert.equal(held.value, undefined);
});

test('m9d697 exportação de degradada é bloqueada', async () => {
  const m = await e.freshMetric(env, tenant);
  const pode = () => e.inTx(tenant, {}, (tx) => quality.assertMetricExportable(ctx(), m.code, e.TODAY, tx));
  await pode();
  await e.recordCheck(tenant, { metrics: [m.code] });
  await assert.rejects(pode, (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'ANALYTICS_EXPORT_DEGRADED_BLOCKED');
    assert.equal(err.message, 'O indicador está com dado incompleto e não pode ser exportado agora.');
    return true;
  });
  const expirada = await e.freshMetric(env, tenant, { ageMinutes: 5000 });
  await assert.rejects(() => e.inTx(tenant, {}, (tx) => quality.assertMetricExportable(ctx(), expirada.code, e.TODAY, tx)), { code: 'ANALYTICS_EXPORT_DEGRADED_BLOCKED' });
});
