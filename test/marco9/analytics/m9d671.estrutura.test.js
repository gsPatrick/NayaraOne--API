'use strict';

// M9-D671 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry,
// origem e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo, colunas novas dos read models).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/mktKpiEnv');
const sc = require('../_helpers/m9d671Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Marketing (papel marketing-gestor)';
const EVENT = { mode: 'EVENT', maxStalenessMinutes: 15 };
const DAILY = { mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 };
const EXPECT = {
  'mkt.deliverability': { model: 'rm_mkt_delivery', unit: 'PERCENT', dimensions: ['empresa', 'canal', 'campanha'], refresh: EVENT },
  'mkt.opt_out': { model: 'rm_mkt_optout_month', unit: 'PERCENT', dimensions: ['empresa', 'canal', 'campanha'], refresh: EVENT },
  'mkt.frequency': { model: 'rm_mkt_frequency', unit: 'NUMBER', dimensions: ['empresa', 'canal'], refresh: DAILY },
  'mkt.automations_blocked_failed': { model: 'rm_mkt_automation', unit: 'COUNT', dimensions: ['empresa', 'automação', 'motivo'], refresh: EVENT },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.mkt.opt_out', 'Controladoria (papel controller)');
  await sc.bom(env, env.cX, kit.src.uuid());
  await kit.refreshAll(env, env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d671 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature, d.criticality], [1, e.unit, code, e.model, 'MARKETING', 'PUBLISHED', 'ACTUAL', 'NORMAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'mkt.opt_out' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual(d.refresh_policy, e.refresh);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d671 os parâmetros existem no SETTINGS_SCHEMA com faixa e padrão do livro', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.mkt_entrega_max_horas'], { type: 'integer', min: 1, max: 720 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.frequencia.janela_dias'], { type: 'integer', min: 1, max: 90 });
  const { MKT_KPI_DEFAULTS } = require('../../../src/features/analytics/read-models/marketingKpi.settings');
  assert.deepEqual([MKT_KPI_DEFAULTS['analytics.qualidade.mkt_entrega_max_horas'], MKT_KPI_DEFAULTS['analytics.frequencia.janela_dias']], [24, 7]);
});

test('m9d671 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
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

test('m9d671 o read model mensal de opt-out tem RLS FORCE, chave (mês, canal) e as colunas novas dos outros três existem', async () => {
  const [[t]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_mkt_optout_month'`);
  assert.deepEqual([t.relrowsecurity, t.relforcerowsecurity, t.policies], [true, true, 4]);
  const [[pk]] = await env.admin.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rm_mkt_optout_month_pk'");
  assert.match(pk.def, /company_id, month, channel/);
  const want = { rm_mkt_delivery: ['bounced', 'awaiting_since', 'by_campaign'], rm_mkt_frequency: ['window_days', 'window_messages', 'window_people', 'unidentified', 'by_channel'], rm_mkt_automation: ['blocked_without_reason', 'blocked_by_reason', 'failed_by_code', 'by_automation'] };
  for (const [table, columns] of Object.entries(want)) {
    const [cols] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :table AND column_name IN (:columns)", { replacements: { table, columns } });
    assert.equal(cols.length, columns.length, table);
  }
});

test('m9d671 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['mktDeliverability.js', 'mktOptOut.js', 'mktFrequency.js', 'mktAutomationsBlockedFailed.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biMarketingKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.frequencia.janela_dias', 'analytics.qualidade.mkt_entrega_max_horas']) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
