'use strict';

// M9-D661 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do
// registry, origem e detalhe do CRITICAL e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d661Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Correspondente Bancário (papel correspondente-gestor)';
const EXPECT = {
  'cor.cases_by_stage': { model: 'rm_fin_cases_stage', unit: 'COUNT', nature: 'ACTUAL', critical: false, dimensions: ['empresa', 'estágio', 'provider', 'corretor'] },
  'cor.approval_rate_by_provider': { model: 'rm_fin_provider_outcome', unit: 'COUNT', nature: 'ACTUAL', critical: false, dimensions: ['empresa', 'provider', 'produto'] },
  'cor.analysis_time': { model: 'rm_fin_provider_outcome', unit: 'DAYS', nature: 'ACTUAL', critical: false, dimensions: ['empresa', 'provider', 'produto'] },
  'cor.commission': { model: 'rm_fin_commission', unit: 'BRL', nature: 'ESTIMATED', critical: true, dimensions: ['empresa', 'provider', 'produto', 'corretor'] },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.cor.commission', 'Controladoria (papel controller)');
  const cases = await sc.casos(env, env.cX);
  await sc.comissoes(env, env.cX, cases.decided[0]);
  await kit.refreshAll(env.cX, cases.decided);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d661 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'CORRESPONDENT', 'PUBLISHED', e.nature]);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'cor.commission' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.maxStalenessMinutes, 15);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, e.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, e.critical);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d661 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  const validate = SETTINGS_SCHEMA['analytics.correspondente.estagios_validos'].validate;
  assert.doesNotThrow(() => validate('k', 'DRAFT, APPROVED'));
  for (const bad of ['', 'draft', 'A,,B', '1A']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.equal(SETTINGS_SCHEMA['analytics.correspondente.estagios_em_analise'].type, 'string');
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.min_amostra'], { type: 'integer', min: 1, max: 1000 });
});

test('m9d661 estagios_em_analise e o owner da empresa são lidos: mudam os pendentes e o registry', async () => {
  const t = env.cX;
  assert.equal((await kit.kpis(t)).cor.kpis['cor.analysis_time'].details.pending, '3');
  await kit.setSetting(env, t, 'analytics.correspondente.estagios_em_analise', 'SUBMITTED'); // só o enviado fica pendente
  assert.equal((await kit.kpis(t)).cor.kpis['cor.analysis_time'].details.pending, '1');
  await kit.setSetting(env, t, 'analytics.correspondente.estagios_em_analise', 'SUBMITTED,UNDER_ANALYSIS,PENDING_CUSTOMER,PENDING_PROPERTY');
});

test('m9d661 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
  await kit.inTx(env.cX, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of Object.keys(EXPECT)) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [rows] = await kit.sequelize.query("SELECT d.metric_code, d.criticality, d.drilldown_enabled, v.version, v.value_nature FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code LIKE 'cor.%' ORDER BY 1", { transaction: tx });
    assert.deepEqual(rows.filter((r) => EXPECT[r.metric_code]).map((r) => [r.metric_code, r.criticality, r.drilldown_enabled, r.version, r.value_nature]), [
      ['cor.analysis_time', 'NORMAL', false, 1, 'ACTUAL'], ['cor.approval_rate_by_provider', 'NORMAL', false, 1, 'ACTUAL'], ['cor.cases_by_stage', 'NORMAL', false, 1, 'ACTUAL'], ['cor.commission', 'CRITICAL', true, 1, 'ESTIMATED'],
    ]);
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d661 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['corCasesByStage.js', 'corApprovalRateByProvider.js', 'corAnalysisTime.js', 'corCommission.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biJuridicoCorrespondenteKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.correspondente.estagios_validos', 'analytics.correspondente.estagios_em_analise']) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
