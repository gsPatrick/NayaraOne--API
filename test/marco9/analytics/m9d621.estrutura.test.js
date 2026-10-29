'use strict';

// M9-D621 — registro dos seis KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e
// detalhe (reconciliação), semente do registry e regras estáticas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const envK = require('../_helpers/finKpiEnv');
const scenario = require('../_helpers/m9d621Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi } = envK;
const API = path.join(__dirname, '..', '..', '..');
const DIMENSIONS = {
  payables: { 7: ['empresa', 'centro de custo', 'conta contábil'], 30: ['empresa', 'centro de custo'], 60: ['empresa', 'centro de custo'] },
  receivables: { 7: ['empresa', 'contrato', 'centro de resultado'], 30: ['empresa', 'contrato', 'centro de resultado'], 60: ['empresa', 'contrato', 'centro de resultado'] },
};
let env;
let row;
before(async () => {
  env = await envK.setup();
  await envK.setSetting(env, env.cX, 'analytics.owner.fin.receivables_60d', 'Controladoria (papel controller)');
  await scenario.seed(env, env.cX);
  await refresh(env.cX);
  await kpis(env.cX);
  row = await envK.healthRow(env, env.cX);
});
after(() => envK.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const code of scenario.CODES) {
  test(`m9d621 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const [, kind, days] = /^fin\.(payables|receivables)_(\d+)d$/.exec(code);
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, 'BRL', code, 'rm_finance_health', 'FINANCE', 'PUBLISHED', 'PLANNED']);
    assert.deepEqual(d.dimensions, DIMENSIONS[kind][days]);
    assert.equal(d.owner_role, code === 'fin.receivables_60d' ? 'Controladoria (papel controller)' : 'Diretoria Financeira (papel financeiro-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.maxStalenessMinutes, 15);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.includes(`${kind}_without_due_date`));
    assert.equal(d.criticality, code === 'fin.payables_7d' ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, code === 'fin.payables_7d');
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
  });
}

test('m9d621 a origem dos seis KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo (SUM)', async () => {
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = envK.ctxOf(env.cX);
    for (const code of scenario.CODES) {
      assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: row.source_criteria[code], unit: 'BRL' }, tx);
      assert.equal(reconcileMode, 'SUM');
      const r = await registry.reconcileDetail(ctx, code, ref, scenario.EXPECTED[code], { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d621 fin.payables_7d (CRITICAL) tem detalhe paginado cuja soma bate com o valor do KPI', async () => {
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = envK.ctxOf(env.cX);
    ctx.permissions = ['analytics:read', 'analytics:drilldown', 'finance:read'];
    const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, 'fin.payables_7d', { filter: row.source_criteria['fin.payables_7d'], unit: 'BRL' }, tx);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'fin.payables_7d', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 1, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(rows.length, 2);
    assert.equal(money.cmp(money.sum(rows.map((r) => r.contribution)), (await readKpi(env.cX, 'fin.payables_7d')).value), 0);
  });
});

test('m9d621 a semente do registry publica a versão 1 dos seis KPIs com o catálogo REAL de fórmulas', async () => {
  await envK.inTx(env.cX, { writer: false }, async (tx) => {
    await envK.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of scenario.CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [[g]] = await envK.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version, v.value_nature FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = 'fin.payables_7d'", { transaction: tx });
    assert.deepEqual(g, { criticality: 'CRITICAL', drilldown_enabled: true, version: 1, value_nature: 'PLANNED' });
    await envK.sequelize.query('SELECT 1', { transaction: tx });
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d621 nenhum KPI desta demanda é calculado no Front e as fórmulas são puras', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['_finWindow.js', 'finPayables7d.js', 'finPayables30d.js', 'finPayables60d.js', 'finReceivables7d.js', 'finReceivables30d.js', 'finReceivables60d.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFinanceiroJanelasGroups.js'), 'utf8');
  for (const code of scenario.CODES) assert.ok(group.includes(`analytics.owner.${code}`), code);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_FINANCEIRO_JANELAS_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
