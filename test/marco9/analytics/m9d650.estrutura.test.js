'use strict';

// M9-D650 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e
// detalhe (reconciliação centavo a centavo), semente do registry e regras estáticas (Front sem cálculo de KPI, arquivos pequenos, fórmulas puras).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d650Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { sourceFilter } = require('../../../src/features/analytics/metrics/kpis/obras/filters');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const API = path.join(__dirname, '..', '..', '..');
const CODES = ['obra.progress_vs_schedule', 'obra.baseline_actual_forecast', 'obra.projected_margin'];
const WANT = {
  'obra.progress_vs_schedule': { unit: 'PERCENT', nature: 'ACTUAL', model: 'rm_project_progress', critical: false, dimensions: ['empresa', 'obra', 'etapa'], cron: '5 0 * * *' },
  'obra.baseline_actual_forecast': { unit: 'BRL', nature: 'PROJECTED', model: 'rm_project_cost', critical: true, dimensions: ['empresa', 'obra', 'etapa', 'período'], cron: '5 0 * * *' },
  'obra.projected_margin': { unit: 'BRL', nature: 'PROJECTED', model: 'rm_project_cost', critical: true, dimensions: ['empresa', 'obra'], cron: '5 0 * * *' },
};
let env;
before(async () => {
  env = await bi.setup();
  await bi.setSetting(env, env.tenantA, 'analytics.owner.obra.projected_margin', 'Controladoria (papel controller)');
  await scenario.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

for (const code of CODES) {
  test(`m9d650 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const w = WANT[code];
    const d = await bi.definitionOf(env, env.tenantA, code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, w.unit, code, w.model, 'CONSTRUCTION', 'PUBLISHED', w.nature]);
    assert.deepEqual(d.dimensions, w.dimensions);
    assert.equal(d.owner_role, code === 'obra.projected_margin' ? 'Controladoria (papel controller)' : 'Diretoria de Obras (papel obras-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.cron], ['SCHEDULE', w.cron]);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length > 0);
    assert.equal(d.criticality, w.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, w.critical);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'tem especificação de origem');
  });
}

test('m9d650 a origem dos KPIs CRITICAL reconcilia centavo a centavo com o valor do KPI (modo SUM)', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    const ctx = bi.ctxOf(env.tenantA);
    for (const code of ['obra.baseline_actual_forecast', 'obra.projected_margin']) {
      const kpi = await bi.readKpi(env.tenantA, code);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: sourceFilter(code, bi.AS_OF), unit: 'BRL' }, tx);
      assert.equal(reconcileMode, 'SUM');
      const r = await registry.reconcileDetail(ctx, code, ref, kpi.value, { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d650 os KPIs CRITICAL têm detalhe paginado cuja soma bate com o valor do KPI', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    const ctx = bi.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'construction:read']);
    for (const code of ['obra.baseline_actual_forecast', 'obra.projected_margin']) {
      const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, code, { filter: sourceFilter(code, bi.AS_OF), unit: 'BRL' }, tx);
      const rows = [];
      let page = 1;
      let body;
      do {
        body = await openDrilldown(ctx, { metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 1, route: 'teste' }, tx);
        rows.push(...body.rows);
        page += 1;
      } while (page <= body.totalPages);
      assert.equal(rows.length, 2, `${code}: uma linha por obra`);
      assert.equal(money.cmp(money.sum(rows.map((r) => r.contribution)), (await bi.readKpi(env.tenantA, code)).value), 0, code);
      assert.ok(rows.every((r) => r.link && r.link.startsWith('/painel/obras/lista/')), 'a linha abre a tela da obra');
    }
  });
});

test('m9d650 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    await bi.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [[g]] = await bi.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version, v.value_nature FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = 'obra.baseline_actual_forecast'", { transaction: tx });
    assert.deepEqual(g, { criticality: 'CRITICAL', drilldown_enabled: true, version: 1, value_nature: 'PROJECTED' });
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d650 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e os arquivos têm até 400 linhas', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['_obraKpi.js', 'obraProgressVsSchedule.js', 'obraBaselineActualForecast.js', 'obraProjectedMargin.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biObrasKpiGroups.js'), 'utf8');
  for (const code of CODES) assert.ok(group.includes(`analytics.owner.${code}`), code);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_OBRAS_KPI_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
  const formulas = spawnSync('node', ['scripts/analytics/checkFormulaTests.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(formulas.status, 0, formulas.stdout + formulas.stderr);
});
