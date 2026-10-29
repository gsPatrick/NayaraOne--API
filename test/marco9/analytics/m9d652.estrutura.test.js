'use strict';

// M9-D652 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e detalhe
// (reconciliação), semente do registry, read model das ocorrências e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const e = require('../_helpers/m9d652Env');
const sc = require('../_helpers/m9d652Scenario');
const refs = require('../_helpers/m9d652Refs');
const seed = require('../../../src/features/analytics/metrics/seed');
const registry = require('../../../src/features/analytics/metrics');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const API = path.join(__dirname, '..', '..', '..');
const CODES = ['obra.waste', 'obra.postwork_cost', 'obra.recurrence'];
const EXPECT = {
  'obra.waste': { model: 'rm_project_waste', unit: 'BRL', dimensions: ['empresa', 'obra', 'material', 'equipe'], critical: true, cron: false },
  'obra.postwork_cost': { model: 'rm_postwork_cost', unit: 'BRL', dimensions: ['empresa', 'obra', 'causa', 'equipe', 'material'], critical: true, cron: false },
  'obra.recurrence': { model: 'rm_project_occurrences', unit: 'COUNT', dimensions: ['empresa', 'causa', 'equipe', 'material'], critical: false, cron: true },
};
let env;
let p1;
const T = () => env.cX;
before(async () => {
  env = await e.setup();
  await e.setSetting(env, T(), 'analytics.owner.obra.postwork_cost', 'Controladoria (papel controller)');
  p1 = await sc.project(env, T());
  const waste = await sc.seedWaste(env, T(), p1);
  const post = await sc.seedPostwork(env, T(), p1);
  await sc.nonconformity(env, T(), p1, sc.at('2026-10-02'), { cause_code: 'x', team_label: 'Equipe X' });
  await sc.refreshProject(T(), p1, { movements: [waste.ids[0]], cases: [post.c1, post.c2], contract: post.contract });
  await e.run(T(), 'obra');
});
after(() => e.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: T().companyId, code } }))[0][0];

for (const code of CODES) {
  test(`m9d652 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    const x = EXPECT[code];
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, x.unit, code, x.model, 'CONSTRUCTION', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, x.dimensions);
    assert.equal(d.owner_role, code === 'obra.postwork_cost' ? 'Controladoria (papel controller)' : 'Diretoria de Obras (papel obras-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.mode, x.cron ? 'SCHEDULE' : 'EVENT');
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, x.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, x.critical);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
  });
}

test('m9d652 os parâmetros da recorrência existem no SETTINGS_SCHEMA com a faixa válida e o padrão do livro', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.obra.recorrencia_dias'], { type: 'integer', min: 1, max: 3650 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.obra.recorrencia_min_ocorrencias'], { type: 'integer', min: 2, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.obra.recorrencia_top'], { type: 'integer', min: 1, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.obra.recorrencia_max_sem_classificacao_pct'], { type: 'integer', min: 0, max: 100 });
  const { OBRA_COST_KPI_DEFAULTS, KEYS } = require('../../../src/features/analytics/read-models/obraPerdasKpi.settings');
  assert.deepEqual([OBRA_COST_KPI_DEFAULTS[KEYS.windowDays], OBRA_COST_KPI_DEFAULTS[KEYS.minOccurrences], OBRA_COST_KPI_DEFAULTS[KEYS.top]], [180, 2, 10], 'livro: 180 dias, 2 ocorrências, 10 maiores');
});

test('m9d652 o read model rm_project_occurrences existe com RLS, FORCE RLS, 4 políticas e o GRANT ao role de runtime', async () => {
  const [[c]] = await env.admin.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_project_occurrences'`);
  assert.deepEqual(c, { rls: true, force: true, policies: 4 });
  const [[g]] = await env.admin.query("SELECT has_table_privilege('nayara_runtime', 'analytics.rm_project_occurrences', 'SELECT,INSERT,UPDATE,DELETE') AS ok");
  assert.equal(g.ok, true);
});

test('m9d652 a origem dos KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo (SUM)', async () => {
  const expected = { 'obra.waste': '14000.00', 'obra.postwork_cost': '38500.00' };
  await e.inTx(T(), {}, async (tx) => {
    const ctx = e.ctxOf(T());
    for (const code of CODES) assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
    for (const code of Object.keys(expected)) {
      const ref = await refs.sourceRef(env, T(), code);
      const r = await registry.reconcileDetail(ctx, code, ref, expected[code], { unit: 'BRL' }, tx);
      assert.equal(r.mode, 'SUM');
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d652 obra.waste e obra.postwork_cost (CRITICAL) têm detalhe paginado cuja soma bate com o valor do KPI', async () => {
  const waste = await refs.drill(env, T(), 'obra.waste', ['construction:read']);
  assert.deepEqual([waste.mode, waste.rows.length], ['SUM', 2], 'duas baixas de perda ligadas a obras (a sem obra e as saídas ficam fora)');
  assert.equal(money.cmp(waste.sum, (await e.readKpi(T(), 'obra.waste')).value), 0);
  assert.equal(money.cmp(waste.aggregate.total, '14000.00'), 0);
  const post = await refs.drill(env, T(), 'obra.postwork_cost', ['construction:read']);
  assert.equal(post.rows.length, 2, 'as duas ações do caso encerrado (o caso aberto fica fora)');
  assert.equal(post.aggregate.adjustments.length, 1, 'mão de obra e material do caso entram como ajuste declarado');
  assert.equal(money.cmp(post.sum, (await e.readKpi(T(), 'obra.postwork_cost')).value), 0, 'linhas + ajuste = valor do KPI');
  assert.ok(post.rows[0].fields.assigned_team !== undefined && post.rows[0].link.startsWith('/painel/obras'));
});

test('m9d652 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas e o read model existente', async () => {
  await e.inTx(T(), { writer: false }, async (tx) => {
    await e.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [[g]] = await e.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version, v.source_read_model FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = 'obra.recurrence'", { transaction: tx });
    assert.deepEqual(g, { criticality: 'NORMAL', drilldown_enabled: false, version: 1, source_read_model: 'rm_project_occurrences' });
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((err) => { if (!err.rollback) throw err; });
});

test('m9d652 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['obraWaste.js', 'obraPostworkCost.js', 'obraRecurrence.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biObrasGroups.js'), 'utf8');
  for (const key of [...CODES.map((c) => `analytics.owner.${c}`), 'analytics.obra.recorrencia_dias', 'analytics.obra.recorrencia_min_ocorrencias', 'analytics.obra.recorrencia_top', 'analytics.obra.recorrencia_max_sem_classificacao_pct']) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
