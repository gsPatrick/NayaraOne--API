'use strict';

// M9-D672 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry e regras
// estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d672Env');
const sc = require('../_helpers/m9d672Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Atendimento (papel atendimento-gestor)';
const EVENT = 15;
const EXPECT = {
  'sup.reviews': { model: 'rm_mkt_reviews', unit: 'SCORE', dimensions: ['empresa', 'plataforma', 'unidade'], mode: 'SCHEDULE', stale: 1440 },
  'sup.satisfaction': { model: 'rm_support_satisfaction', unit: 'SCORE', dimensions: ['empresa', 'área', 'atendente'], mode: 'EVENT', stale: EVENT },
  'sup.complaints_by_reason': { model: 'rm_support_complaints', unit: 'COUNT', dimensions: ['empresa', 'motivo', 'área'], mode: 'EVENT', stale: EVENT },
  'sup.sla_resolution': { model: 'rm_support_sla', unit: 'PERCENT', dimensions: ['empresa', 'prioridade', 'área'], mode: 'SCHEDULE', stale: 60 },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.sup.reviews', 'Marketing (papel marketing-gestor)');
  await sc.avaliacoes(env, env.cX);
  await sc.reclamacoes(env, env.cX);
  await sc.slas(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d672 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'SUPPORT', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'sup.reviews' ? 'Marketing (papel marketing-gestor)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.maxStalenessMinutes], [e.mode, e.stale]);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d672 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  for (const p of ['ALTA', 'MEDIA', 'BAIXA']) assert.deepEqual(SETTINGS_SCHEMA[`analytics.sla.horas.${p}`], { type: 'integer', min: 1, max: 8760 }, p);
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_sem_motivo_pct'], { type: 'integer', min: 0, max: 100 });
  const validate = SETTINGS_SCHEMA['analytics.sla.severidades.ALTA'].validate;
  assert.doesNotThrow(() => validate('k', 'HIGH, CRITICAL'));
  for (const bad of ['', 'high', 'A,,B', '1A']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.ok(SETTINGS_SCHEMA['analytics.qualidade.min_amostra'], 'a amostra mínima é a do funil, compartilhada');
});

test('m9d672 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
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

test('m9d672 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['supReviews.js', 'supSatisfaction.js', 'supComplaintsByReason.js', 'supSlaResolution.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biAtendimentoKpiGroups.js'), 'utf8');
  const keys = [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.sla.horas.ALTA', 'analytics.sla.horas.MEDIA', 'analytics.sla.horas.BAIXA', 'analytics.qualidade.max_sem_motivo_pct',
    'analytics.sla.severidades.ALTA', 'analytics.sla.severidades.MEDIA', 'analytics.sla.severidades.BAIXA'];
  for (const key of keys) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
