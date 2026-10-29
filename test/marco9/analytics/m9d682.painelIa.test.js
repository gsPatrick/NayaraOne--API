'use strict';

// M9-D682 com a M9-D681 — o painel Segurança/Integrações/IA mostra os quatro KPIs de IA calculados de verdade a partir das fontes (execuções, orçamentos, chamadas de ferramenta e
// avaliações): os números da tela são os do endpoint de métrica e os da fonte; com a regra de qualidade violada o cartão mostra "Dado incompleto" e a faixa de qualidade avisa antes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/analyticsHttpEnv');
const bi = require('../_helpers/biObrasJuridicoEnv');
const kit = require('../_helpers/m9d681Env');
const oracle = require('../_helpers/m9d681Oracle');
const painel = require('../_helpers/painelBiEnv');
const clock = require('../../../src/features/analytics/metrics/clock');
const { materializeIaKpis } = require('../../../src/features/analytics/metrics/kpis');

const { AS_OF, MODELS } = { ...kit };
const PERMS = ['analytics:read', 'analytics:read:tech'];
const IA = ['ai.cost_by_agent', 'ai.budget', 'ai.quality_scores', 'ai.tool_calls_blocked'];
let env;
let src;
const refresh = async () => {
  await bi.runSchedule(env.tenantA, bi.NOW);
  await http.inTx(env.tenantA, { commit: true }, (tx) => materializeIaKpis({ companyId: env.tenantA.companyId, groupId: env.tenantA.groupId }, AS_OF, tx));
};
const open = async () => (await painel.openPanel(env, 'tech', { perms: PERMS }));
const widget = (res, code) => res.body.data.widgets.find((w) => w.metricCode === code);
const drop = (id) => env.admin.transaction(async (transaction) => {
  await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
  await env.admin.query('DELETE FROM ai.ai_runs WHERE id = :id', { replacements: { id }, transaction });
});

before(async () => {
  env = await http.setup();
  clock.setClock(bi.NOW);
  src = { admin: env.admin, created: [] };
  await kit.seedAi(src, env.tenantA);
  await refresh();
});
after(async () => {
  clock.resetClock();
  const ids = { c: env.tenantA.companyId };
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const { table, id } of [...src.created].reverse()) await env.admin.query(`DELETE FROM ${table} WHERE id = :id`, { replacements: { id }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id = :c)', { replacements: ids, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id = :c', { replacements: ids, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id = :c', { replacements: ids, transaction });
    for (const m of MODELS) await env.admin.query(`DELETE FROM analytics.${m} WHERE company_id = :c`, { replacements: ids, transaction });
    for (const t of ['rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id = :c`, { replacements: ids, transaction });
  });
  painel.dashboards.clearCache();
  await http.teardown(env);
});

test('m9d682 os quatro cartões de IA do painel mostram os números da fonte e iguais ao endpoint de métrica', async () => {
  const res = await open();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cost = widget(res, 'ai.cost_by_agent');
  assert.equal(cost.metric.formatted, 'R$ 655,50');
  assert.equal(Number(cost.metric.value), Number((await oracle.cost(src, env.tenantA, '2026-10')).total));
  assert.deepEqual(cost.view.items.map((i) => [i.id, i.cells.map((c) => c.formatted)]), [['NAY_COMERCIAL', ['R$ 640,00', '8', 'R$ 80,00']], ['NAY_FINANCEIRO', ['R$ 15,50', '2', 'R$ 7,75']]]);
  const budget = widget(res, 'ai.budget');
  assert.equal(budget.metric.formatted, '71,25%');
  assert.deepEqual(budget.view.items.find((i) => i.id === 'NAY_COMERCIAL').cells.map((c) => c.formatted), ['71,11%', 'R$ 640,00', 'R$ 900,00', 'R$ 708,57']);
  const quality = widget(res, 'ai.quality_scores');
  assert.equal(quality.metric.formatted, '80,00%');
  assert.equal(quality.view.facts.find((f) => f.key === 'avaliacao_nota').formatted, '58,3');
  const tools = widget(res, 'ai.tool_calls_blocked');
  assert.equal(tools.metric.formatted, '3');
  assert.deepEqual(tools.view.facts.map((f) => f.formatted), ['13', '23,08%']);
  for (const code of IA) {
    const direct = (await painel.getMetric(env, code, PERMS)).body.data;
    const w = widget(res, code);
    assert.deepEqual([w.metric.value, w.metric.status, w.metric.version], [direct.value, direct.status, direct.version], code);
  }
});

test('m9d682 com a regra de qualidade violada o cartão mostra Dado incompleto e a faixa de qualidade avisa antes dos números', async () => {
  const noCost = await kit.runOf(src, env.tenantA, 'nay_comercial', '2026-10-28T14:00:00Z', null); // execução com modelo e sem custo gravado
  const noBudget = await kit.budget(src, env.tenantA, 'NAY_SEM_ORCAMENTO', '10.00', '2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z');
  try {
    await env.admin.query("UPDATE ai.budgets SET status = 'PAUSED' WHERE id = :id", { replacements: { id: noBudget } });
    await refresh();
    const res = await open();
    const cost = widget(res, 'ai.cost_by_agent');
    assert.deepEqual([cost.metric.incomplete, cost.metric.value, cost.metric.formatted, cost.metric.incompleteText, cost.metric.status], [true, null, null, 'Dado incompleto', 'DEGRADED']);
    assert.deepEqual(cost.view.items, []);
    assert.equal(widget(res, 'ai.quality_scores').metric.status, 'OK', 'os outros indicadores seguem com número');
    const banner = res.body.data.widgets[0];
    assert.equal(banner.type, 'QUALITY_BANNER');
    assert.ok(banner.banner.visible && banner.banner.degradedMetrics.some((m) => (m.metricCode || m) === 'ai.cost_by_agent'), 'a faixa lista o indicador degradado');
  } finally {
    await drop(noCost);
    await env.admin.query('DELETE FROM ai.budgets WHERE id = :id', { replacements: { id: noBudget } });
  }
  await refresh();
  const back = widget(await open(), 'ai.cost_by_agent');
  assert.deepEqual([back.metric.incomplete, back.metric.formatted], [false, 'R$ 655,50'], 'recalculado da fonte, o número volta');
});
