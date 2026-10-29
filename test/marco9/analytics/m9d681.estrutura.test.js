'use strict';

// M9-D681 — registro dos quatro KPIs de IA (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry, origem, colunas
// novas dos read models e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo, todo parâmetro lido).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d681Env');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { IA_KPI_DEFAULTS, KEYS } = require('../../../src/features/analytics/read-models/iaKpi.settings');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Tecnologia (papel ti-gestor)';
const EVENT = { mode: 'EVENT', stale: 15 };
const EXPECT = {
  'ai.cost_by_agent': { model: 'rm_ai_cost', unit: 'BRL', dimensions: ['empresa', 'agente', 'modelo'], ...EVENT },
  'ai.quality_scores': { model: 'rm_ai_quality', unit: 'PERCENT', dimensions: ['empresa', 'agente', 'semana'], mode: 'SCHEDULE', cron: '0 3 * * 1', stale: 10080 },
  'ai.budget': { model: 'rm_ai_cost', unit: 'PERCENT', dimensions: ['empresa', 'agente'], ...EVENT },
  'ai.tool_calls_blocked': { model: 'rm_ai_tool_calls', unit: 'COUNT', dimensions: ['empresa', 'agente', 'ferramenta', 'motivo'], ...EVENT },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.ai.budget', 'Controladoria (papel controller)');
  await kit.seedAi(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d681 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'TECH_AI', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'ai.budget' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.cron || null, d.refresh_policy.maxStalenessMinutes], [e.mode, e.cron || null, e.stale]);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, false);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d681 os parâmetros existem no SETTINGS_SCHEMA com o padrão do livro, rejeitam valor inválido e todos são lidos pelo código', () => {
  for (const key of Object.values(KEYS)) assert.ok(SETTINGS_SCHEMA[key] && IA_KPI_DEFAULTS[key] !== undefined, key);
  assert.deepEqual([IA_KPI_DEFAULTS[KEYS.alertBudgetPct], IA_KPI_DEFAULTS[KEYS.qualityWeeks], IA_KPI_DEFAULTS[KEYS.minSample]], [80, 4, 5]);
  for (const bad of ['', 'permissao', 'A,,B']) assert.throws(() => SETTINGS_SCHEMA[KEYS.knownBlockReasons].validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  const text = ['read-models/iaKpi.settings.js', 'metrics/kpis/ia/inputs.js', 'metrics/kpis/ia/rows.js', 'metrics/kpis/ia/set.js']
    .map((f) => fs.readFileSync(path.join(API, 'src/features/analytics', f), 'utf8')).join('\n');
  for (const name of ['alertBudgetPct', 'qualityWeeks', 'minSample', 'knownBlockReasons']) {
    assert.match(text.replace(/\/\*[\s\S]*?\*\//g, ''), new RegExp(`\\b${name}\\b[\\s\\S]*\\b${name}\\b`), `${name} é lido além de declarado`);
  }
  const used = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/kpis/ia/inputs.js'), 'utf8');
  for (const field of ['minSample', 'alertBudgetPct', 'knownBlockReasons']) assert.ok(used.includes(`s.${field}`), `a fórmula recebe ${field} do parâmetro`);
  assert.ok(fs.readFileSync(path.join(API, 'src/features/analytics/metrics/kpis/ia/rows.js'), 'utf8').includes('settings.qualityWeeks'), 'as semanas do histórico saem do parâmetro');
});

test('m9d681 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
  await kit.inTx(env.cX, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of Object.keys(EXPECT)) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d681 cada KPI tem especificação de origem e detalhe, e o filtro reproduz o recorte do mês', async () => {
  const { detailOf } = require('../../../src/features/analytics/metrics/drilldown.details');
  assert.deepEqual(['ai.cost_by_agent', 'ai.quality_scores', 'ai.budget', 'ai.tool_calls_blocked'].map((c) => registry.getSourceSpec(c).table), ['ai.ai_runs', 'ai.ai_runs', 'ai.budgets', 'ai.tool_calls']);
  assert.equal(registry.reconcileModeForUnit('BRL'), 'SUM');
  assert.equal(registry.reconcileModeForUnit('COUNT'), 'COUNT');
  for (const code of Object.keys(EXPECT)) assert.ok(detailOf(registry.getSourceSpec(code)).columns.length >= 1, `${code} tem detalhe`);
  const { iaFilterOf } = require('../../../src/features/analytics/metrics/kpis/ia/filters');
  const month = iaFilterOf('ai.cost_by_agent', '2026-10-28');
  assert.deepEqual([month.period.from, month.period.to, month.status], ['2026-10-01T03:00:00.000Z', '2026-11-01T03:00:00.000Z', ['COMPLETED']], 'mês de São Paulo: meia-noite de SP, fim exclusivo');
  const week = iaFilterOf('ai.quality_scores', '2026-10-28');
  assert.deepEqual([week.period.from, week.period.to], ['2026-10-26T03:00:00.000Z', '2026-11-02T03:00:00.000Z'], 'semana de segunda a domingo');
  assert.deepEqual(iaFilterOf('ai.tool_calls_blocked', '2026-10-28').status, ['BLOCKED']);
});

test('m9d681 as colunas novas dos read models existem, são nulas até o recálculo e o RLS FORCE continua valendo', async () => {
  const cols = (await env.admin.query(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name IN ('rm_ai_cost', 'rm_ai_tool_calls')
        AND column_name IN ('runs_without_cost', 'by_model', 'by_tool', 'by_reason') ORDER BY 1, 2`
  ))[0];
  assert.deepEqual(cols.map((c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`), ['rm_ai_cost.by_model:YES', 'rm_ai_cost.runs_without_cost:YES', 'rm_ai_tool_calls.by_reason:YES', 'rm_ai_tool_calls.by_tool:YES']);
  const rls = (await env.admin.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls') ORDER BY 1"))[0];
  assert.deepEqual(rls.map((r) => [r.relrowsecurity, r.relforcerowsecurity]), [[true, true], [true, true], [true, true]]);
  await env.admin.query("UPDATE analytics.rm_ai_cost SET runs_without_cost = NULL, by_model = NULL WHERE company_id = :c", { replacements: { c: env.cX.companyId } });
  const notYet = (await kit.kpis(env.cX)).ia.kpis['ai.cost_by_agent'];
  assert.deepEqual([notYet.status, notYet.value, notYet.details.reason], ['INCOMPLETE', null, 'AINDA_NAO_CALCULADO'], 'nulo = ainda não calculado: sem valor');
  await kit.rebuild(env.cX);
  assert.equal((await kit.kpis(env.cX)).ia.kpis['ai.cost_by_agent'].status, 'OK');
});

test('m9d681 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['aiCostByAgent.js', 'aiQualityScores.js', 'aiBudget.js', 'aiToolCallsBlocked.js', '_aiKpi.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biIaKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), KEYS.alertBudgetPct, KEYS.qualityWeeks, KEYS.knownBlockReasons]) assert.ok(group.includes(`"${key}"`), `o Front tem o campo ${key}`);
  assert.ok(fs.readFileSync(path.join(front, 'biFunilComercialGroups.js'), 'utf8').includes(`"${KEYS.minSample}"`), 'o mínimo de amostra tem campo no Front');
  assert.ok(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8').includes('BI_IA_KPI_GROUPS'), 'o grupo está ligado à aba BI');
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
