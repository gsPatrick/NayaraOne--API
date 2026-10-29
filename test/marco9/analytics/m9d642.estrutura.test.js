'use strict';

// M9-D642 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry, origem
// e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo, migration).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d642Env');
const sc = require('../_helpers/m9d642Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Gerência de Locação (papel locação-gestor)';
const EXPECT = {
  'rent.tickets': { model: 'rm_rental_tickets', unit: 'COUNT', dimensions: ['empresa', 'tipo', 'contrato', 'imóvel'], refresh: ['EVENT', undefined] },
  'rent.satisfaction': { model: 'rm_rental_satisfaction', unit: 'SCORE', dimensions: ['empresa', 'papel', 'contrato'], refresh: ['EVENT', undefined] },
  'rent.repasses': { model: 'rm_rental_repasses', unit: 'COUNT', dimensions: ['empresa', 'proprietário', 'contrato'], refresh: ['SCHEDULE', '*/15 * * * *'] },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.rent.satisfaction', 'Controladoria (papel controller)');
  await sc.chamados(env, env.cX);
  await sc.satisfacao(env, env.cX);
  await sc.repasses(env, env.cX);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d642 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature, d.criticality], [1, e.unit, code, e.model, 'RENTAL', 'PUBLISHED', 'ACTUAL', 'NORMAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'rent.satisfaction' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.cron, d.refresh_policy.maxStalenessMinutes], [e.refresh[0], e.refresh[1], 15], 'política de atualização da tabela de criticidade');
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.drilldown_enabled, false);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d642 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas', async () => {
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

test('m9d642 as colunas novas dos read models existem, aceitam nulo (ainda não calculado) e recusam negativo', async () => {
  const cols = { rm_rental_tickets: ['opened_period', 'closed_period', 'resolution_hours_period', 'without_open_date'], rm_rental_satisfaction: ['tenant_responses', 'tenant_score_sum', 'owner_responses', 'owner_score_sum'], rm_rental_repasses: ['due_count', 'on_time_count', 'without_due_date'] };
  for (const [table, names] of Object.entries(cols)) {
    const [rows] = await env.admin.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :table", { replacements: { table } });
    for (const name of names) assert.equal(rows.find((r) => r.column_name === name)?.is_nullable, 'YES', `${table}.${name}`);
  }
  await assert.rejects(env.admin.query(`UPDATE analytics.rm_rental_repasses SET due_count = -1 WHERE company_id = :c`, { replacements: { c: env.cX.companyId } }), /check/i);
});

test('m9d642 a migration das colunas é idempotente e reversível', async () => {
  const migration = require('../../../migrations/20260101009883-add-kpi-fields-to-rm-rental-care');
  await migration.up({ sequelize: env.admin });
  await migration.up({ sequelize: env.admin });
  await migration.down({ sequelize: env.admin });
  const [gone] = await env.admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'rm_rental_repasses' AND column_name = 'due_count'");
  assert.equal(gone.length, 0);
  await migration.up({ sequelize: env.admin });
  const [back] = await env.admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'rm_rental_repasses' AND column_name = 'due_count'");
  assert.equal(back.length, 1);
});

test('m9d642 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['rentTickets.js', 'rentSatisfaction.js', 'rentRepasses.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biLocacaoAtendimentoKpiGroups.js'), 'utf8');
  for (const key of Object.keys(EXPECT).map((c) => `analytics.owner.${c}`)) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_LOCACAO_ATENDIMENTO_KPI_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
