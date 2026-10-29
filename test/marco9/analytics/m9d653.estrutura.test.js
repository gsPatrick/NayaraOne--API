'use strict';

// M9-D653 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e detalhe
// (reconciliação), semente do registry e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d653Scenario');
const refs = require('../_helpers/m9d652Refs');
const seed = require('../../../src/features/analytics/metrics/seed');
const registry = require('../../../src/features/analytics/metrics');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const API = path.join(__dirname, '..', '..', '..');
const CODES = ['inv.stock_value', 'inv.below_minimum', 'inv.losses', 'inv.tools_overdue'];
const EXPECT = {
  'inv.stock_value': { model: 'rm_inventory_health', unit: 'BRL', dimensions: ['empresa', 'local', 'categoria'], critical: false, cron: false },
  'inv.below_minimum': { model: 'rm_inventory_health', unit: 'COUNT', dimensions: ['empresa', 'local', 'categoria'], critical: false, cron: false },
  'inv.losses': { model: 'rm_inventory_health', unit: 'BRL', dimensions: ['empresa', 'obra', 'tipo de perda'], critical: true, cron: false },
  'inv.tools_overdue': { model: 'rm_tool_assets', unit: 'COUNT', dimensions: ['empresa', 'responsável', 'categoria de ferramenta'], critical: false, cron: true, drilldown: true },
};
let env;
const T = () => env.cX;
before(async () => {
  env = await e.setup();
  await e.setSetting(env, T(), 'analytics.owner.inv.losses', 'Controladoria (papel controller)');
  const stock = await sc.seedStock(env, T());
  await sc.seedLosses(env, T(), stock.a);
  await sc.seedTools(env, T());
  await sc.refresh(T());
  await e.run(T(), 'inv');
});
after(() => e.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: T().companyId, code } }))[0][0];

for (const code of CODES) {
  test(`m9d653 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    const x = EXPECT[code];
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, x.unit, code, x.model, 'INVENTORY', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, x.dimensions);
    assert.equal(d.owner_role, code === 'inv.losses' ? 'Controladoria (papel controller)' : 'Almoxarifado (papel estoque-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.mode, x.cron ? 'SCHEDULE' : 'EVENT');
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, x.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, x.critical || x.drilldown === true);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
  });
}

test('m9d653 o read model guarda a contagem de perdas, os casos abertos e as perdas sem valor', async () => {
  const [[row]] = await env.admin.query("SELECT losses_30d_count, losses_open, losses_without_value, stock_value::text AS stock_value FROM analytics.rm_inventory_health WHERE company_id = :c AND as_of_date = '2026-10-28'", { replacements: { c: T().companyId } });
  assert.deepEqual(row, { losses_30d_count: 2, losses_open: 1, losses_without_value: 0, stock_value: '900.00' });
});

test('m9d653 a origem dos KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo', async () => {
  const expected = { 'inv.stock_value': ['SUM', '900.00', 'BRL'], 'inv.below_minimum': ['COUNT', '2', 'COUNT'], 'inv.losses': ['SUM', '2450.00', 'BRL'], 'inv.tools_overdue': ['COUNT', '2', 'COUNT'] };
  await e.inTx(T(), {}, async (tx) => {
    const ctx = e.ctxOf(T());
    for (const code of CODES) {
      assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
      const [mode, value, unit] = expected[code];
      const r = await registry.reconcileDetail(ctx, code, await refs.sourceRef(env, T(), code), value, { unit }, tx);
      assert.equal(r.mode, mode);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d653 inv.losses (CRITICAL) tem detalhe paginado cuja soma bate com o valor do KPI', async () => {
  const d = await refs.drill(env, T(), 'inv.losses', ['inventory:read']);
  assert.equal(d.mode, 'SUM');
  assert.equal(d.rows.length, 2, 'os dois casos decididos como perda na janela (rejeitado, antigo e aberto ficam fora)');
  assert.equal(d.aggregate.adjustments.length, 1, 'o custo do movimento no lugar do estimado entra como ajuste declarado');
  assert.equal(money.cmp(d.sum, (await e.readKpi(T(), 'inv.losses')).value), 0, 'linhas + ajuste = valor do KPI');
  assert.ok(d.rows[0].link.startsWith('/painel/estoque'));
  const tools = await refs.drill(env, T(), 'inv.tools_overdue', ['inventory:read']);
  assert.equal(tools.rows.length, 2, 'os dois empréstimos em atraso: a lista vai ao detalhe');
});

test('m9d653 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas e o read model existente', async () => {
  await e.inTx(T(), { writer: false }, async (tx) => {
    await e.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [[g]] = await e.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = 'inv.losses'", { transaction: tx });
    assert.deepEqual(g, { criticality: 'CRITICAL', drilldown_enabled: true, version: 1 });
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((err) => { if (!err.rollback) throw err; });
});

test('m9d653 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['invStockValue.js', 'invBelowMinimum.js', 'invLosses.js', 'invToolsOverdue.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biObrasGroups.js'), 'utf8');
  for (const code of CODES) assert.ok(group.includes(`analytics.owner.${code}`), code);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
