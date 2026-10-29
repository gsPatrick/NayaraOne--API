'use strict';

// M9-D670 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry,
// origem e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo, migrations e read models novos).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d670Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Marketing (papel marketing-gestor)';
const EVENT = { mode: 'EVENT', maxStalenessMinutes: 15 };
const DAILY = { mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 };
const EXPECT = {
  'mkt.campaigns': { model: 'rm_mkt_campaigns', unit: 'COUNT', dimensions: ['empresa', 'canal', 'campanha'], refresh: EVENT },
  'mkt.cost': { model: 'rm_mkt_campaign_month', unit: 'BRL', dimensions: ['empresa', 'campanha', 'canal'], refresh: EVENT },
  'mkt.leads': { model: 'rm_mkt_campaign_month', unit: 'COUNT', dimensions: ['empresa', 'campanha', 'canal'], refresh: EVENT },
  'mkt.attribution': { model: 'rm_mkt_campaign_month', unit: 'BRL', dimensions: ['empresa', 'campanha', 'canal'], refresh: DAILY },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.mkt.cost', 'Controladoria (papel controller)');
  await sc.bom(env, env.cX);
  await kit.refreshAll(env, env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d670 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature, d.criticality], [1, e.unit, code, e.model, 'MARKETING', 'PUBLISHED', 'ACTUAL', 'NORMAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'mkt.cost' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual(d.refresh_policy, e.refresh);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d670 os parâmetros existem no SETTINGS_SCHEMA com faixa e padrão do livro', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_sem_campanha_pct'], { type: 'integer', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_fora_janela_pct'], { type: 'integer', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.frequencia.janela_dias'], { type: 'integer', min: 1, max: 90 });
  const { MKT_KPI_DEFAULTS } = require('../../../src/features/analytics/read-models/marketingKpi.settings');
  assert.deepEqual([MKT_KPI_DEFAULTS['analytics.qualidade.max_sem_campanha_pct'], MKT_KPI_DEFAULTS['analytics.qualidade.max_fora_janela_pct']], [20, 100]);
});

test('m9d670 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
  await kit.inTx(env.cX, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of Object.keys(EXPECT)) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [rows] = await kit.sequelize.query("SELECT d.metric_code, v.version, v.formula_id, v.source_read_model FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code IN (:codes) ORDER BY 1", { replacements: { codes: Object.keys(EXPECT) }, transaction: tx });
    assert.deepEqual(rows.map((r) => [r.metric_code, r.version, r.formula_id, r.source_read_model]), Object.keys(EXPECT).sort().map((c) => [c, 1, c, EXPECT[c].model]));
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d670 os read models novos têm RLS FORCE, escrita só do worker e GRANT com guarda; a tabela mensal reaproveita a chave (campanha, mês)', async () => {
  const [[t]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_mkt_campaign_month'`);
  assert.deepEqual([t.relrowsecurity, t.relforcerowsecurity, t.policies], [true, true, 4]);
  const [pk] = (await env.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rm_mkt_campaign_month_pk'"))[0];
  assert.match(pk.def, /company_id, campaign_id, month/);
  const migration = fs.readFileSync(path.join(API, 'migrations', '20260101009817-create-analytics-rm-mkt-campaign-month.js'), 'utf8');
  assert.match(migration, /grantRuntime/);
  assert.match(fs.readFileSync(path.join(API, 'migrations', '_helpers', 'analyticsReadModelTables.js'), 'utf8'), /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime'\)/);
  const [cols] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'rm_mkt_campaigns' AND column_name IN ('channels','state','started_on','ended_on','has_cost_link')");
  assert.equal(cols.length, 5);
});

test('m9d670 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['mktCampaigns.js', 'mktCost.js', 'mktLeads.js', 'mktAttribution.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biMarketingKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.qualidade.max_sem_campanha_pct', 'analytics.qualidade.max_fora_janela_pct']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_MARKETING_KPI_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
