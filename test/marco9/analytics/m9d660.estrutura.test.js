'use strict';

// M9-D660 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do
// registry, origem e detalhe dos CRITICAL e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/legalCorEnv');
const sc = require('../_helpers/m9d660Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const EXPECT = {
  'legal.deadlines': { model: 'rm_legal_deadlines', unit: 'COUNT', nature: 'ACTUAL', critical: true, refresh: 1440, dimensions: ['empresa', 'tipo de prazo', 'responsável', 'processo'] },
  'legal.cases_by_risk': { model: 'rm_legal_cases_risk', unit: 'COUNT', nature: 'ACTUAL', critical: true, refresh: 15, dimensions: ['empresa', 'risco', 'tipo de processo'] },
  'legal.values': { model: 'rm_legal_values', unit: 'BRL', nature: 'ESTIMATED', critical: false, refresh: 15, dimensions: ['empresa', 'tipo de processo', 'risco'] },
  'legal.missing_documents': { model: 'rm_legal_missing_docs', unit: 'COUNT', nature: 'ACTUAL', critical: false, refresh: 15, dimensions: ['empresa', 'tipo de documento', 'contrato'] },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.legal.values', 'Controladoria (papel controller)');
  await sc.tudo(env, env.cX);
  await kit.refreshAll(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d660 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'LEGAL', 'PUBLISHED', e.nature]);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'legal.values' ? 'Controladoria (papel controller)' : 'Jurídico (papel jurídico-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.maxStalenessMinutes, e.refresh);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, e.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, e.critical);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d660 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_sem_risco_pct'], { type: 'integer', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_exigencia_sem_prazo_pct'], { type: 'integer', min: 0, max: 100 });
});

test('m9d660 cada parâmetro do Jurídico é lido: o owner da empresa vai para o registry e o limite muda o resultado', async () => {
  const { readJurCorKpiParams, readJurCorOwner, JUR_COR_KPI_DEFAULTS } = require('../../../src/features/analytics/read-models/juridicoCorrespondenteKpi.settings');
  await kit.setSetting(env, env.cY, 'analytics.qualidade.max_sem_risco_pct', 42);
  await kit.setSetting(env, env.cY, 'analytics.qualidade.max_exigencia_sem_prazo_pct', 7);
  await kit.setSetting(env, env.cY, 'analytics.owner.legal.deadlines', '  Diretoria  ');
  const read = await kit.inTx(env.cY, {}, async (tx) => ({ p: await readJurCorKpiParams(env.cY, tx), o: await readJurCorOwner('legal.deadlines', env.cY, tx) }));
  assert.deepEqual([read.p.maxNoRiskPct, read.p.maxNoDeadlinePct, read.o], [42, 7, 'Diretoria']);
  const fresh = await kit.inTx(env.cX, {}, async (tx) => readJurCorKpiParams(env.cX, tx));
  assert.deepEqual([fresh.maxNoRiskPct, fresh.maxNoDeadlinePct], [JUR_COR_KPI_DEFAULTS['analytics.qualidade.max_sem_risco_pct'], JUR_COR_KPI_DEFAULTS['analytics.qualidade.max_exigencia_sem_prazo_pct']], 'sem configuração vale o padrão da demanda');
});

test('m9d660 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
  await kit.inTx(env.cX, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of Object.keys(EXPECT)) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [rows] = await kit.sequelize.query("SELECT d.metric_code, d.criticality, d.drilldown_enabled, v.version, v.value_nature FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code LIKE 'legal.%' ORDER BY 1", { transaction: tx });
    assert.deepEqual(rows.filter((r) => EXPECT[r.metric_code]).map((r) => [r.metric_code, r.criticality, r.drilldown_enabled, r.version, r.value_nature]), [
      ['legal.cases_by_risk', 'CRITICAL', true, 1, 'ACTUAL'], ['legal.deadlines', 'CRITICAL', true, 1, 'ACTUAL'], ['legal.missing_documents', 'NORMAL', false, 1, 'ACTUAL'], ['legal.values', 'NORMAL', false, 1, 'ESTIMATED'],
    ]);
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d660 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['legalDeadlines.js', 'legalCasesByRisk.js', 'legalValues.js', 'legalMissingDocuments.js', '_legalCorKpi.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biJuridicoCorrespondenteKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.qualidade.max_sem_risco_pct', 'analytics.qualidade.max_exigencia_sem_prazo_pct']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_JURIDICO_CORRESPONDENTE_KPI_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
