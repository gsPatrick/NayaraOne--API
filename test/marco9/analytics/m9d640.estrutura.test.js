'use strict';

// M9-D640 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e detalhe (reconciliação no modo do
// tipo), semente do registry e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d640Env');
const sc = require('../_helpers/m9d640Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { rentalPortfolioFilterOf } = require('../../../src/features/analytics/metrics/kpis/locacao-carteira/filters');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Gerência de Locação (papel locação-gestor)';
const EXPECT = {
  'rent.active_contracts': { model: 'rm_rental_contracts', unit: 'COUNT', critical: false, refresh: { mode: 'EVENT', maxStalenessMinutes: 15 }, dimensions: ['empresa', 'imóvel', 'proprietário', 'faixa de valor'] },
  'rent.vacancy': { model: 'rm_rental_vacancy', unit: 'PERCENT', critical: false, refresh: { mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 }, dimensions: ['empresa', 'tipo', 'bairro', 'proprietário'] },
  'rent.delinquency': { model: 'rm_rental_arrears', unit: 'PERCENT', critical: true, refresh: { mode: 'SCHEDULE', cron: '*/15 * * * *', maxStalenessMinutes: 15 }, dimensions: ['empresa', 'contrato', 'imóvel', 'faixa de atraso'] },
};
let env;
let cart;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.rent.vacancy', 'Controladoria (papel controller)');
  cart = await sc.carteira(env, env.cX);
  await sc.inadimplencia(env, env.cX, cart);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d640 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'RENTAL', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'rent.vacancy' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual(d.refresh_policy, e.refresh);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, e.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, e.critical);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d640 o parâmetro das faixas de valor existe no SETTINGS_SCHEMA e rejeita valor inválido', () => {
  const validate = SETTINGS_SCHEMA['analytics.locacao.faixas_valor_aluguel'].validate;
  for (const ok of ['2000,5000,10000', '1500', '1,2,3,4,5,6']) assert.doesNotThrow(() => validate('k', ok), ok);
  for (const bad of ['5000,2000', '100,100', 'a,b', '', '0,10', '1,2,3,4,5,6,7', '10.5,20']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.ok(SETTINGS_SCHEMA['analytics.locacao.tipos_contrato'] && SETTINGS_SCHEMA['analytics.inadimplencia.janela_dias'] && SETTINGS_SCHEMA['analytics.inadimplencia.faixas_atraso_dias'], 'os tipos de contrato, a janela e as faixas de atraso são parâmetros');
});

test('m9d640 a origem dos KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo', async () => {
  const settings = { leaseTypes: ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'], worksStatuses: ['ACTIVE', 'PAUSED', 'FINAL_INSPECTION'], windowDays: 90 };
  await kit.inTx(env.cX, {}, async (tx) => {
    const ctx = kit.ctxOf(env.cX);
    const build = (code) => registry.buildSourceRefs(ctx, code, { filter: rentalPortfolioFilterOf(code, env.asOf, settings), unit: EXPECT[code].unit }, tx);
    const active = await build('rent.active_contracts');
    assert.equal(active.reconcileMode, 'COUNT');
    assert.equal((await registry.reconcileDetail(ctx, 'rent.active_contracts', active.sourceRefs[0], '85', { unit: 'COUNT' }, tx)).ok, true);
    const vacancy = await build('rent.vacancy');
    assert.equal(vacancy.reconcileMode, 'RECOMPUTE');
    assert.equal(vacancy.sourceRefs[0].count, 91);
    const v = await registry.reconcileDetail(ctx, 'rent.vacancy', vacancy.sourceRefs[0], '6.59', { unit: 'PERCENT' }, tx);
    assert.equal(v.ok, true, `a vacância refeita sobre as linhas ${v.detail} x KPI ${v.kpi}`);
    const delinquency = await build('rent.delinquency');
    assert.equal(delinquency.reconcileMode, 'RECOMPUTE');
    assert.equal(delinquency.sourceRefs[0].count, 3);
    const d = await registry.reconcileDetail(ctx, 'rent.delinquency', delinquency.sourceRefs[0], '4.10', { unit: 'PERCENT', asOfDate: env.asOf }, tx);
    assert.equal(d.ok, true, `a taxa refeita sobre as linhas ${d.detail} x KPI ${d.kpi}`);
    assert.equal((await registry.reconcileDetail(ctx, 'rent.delinquency', delinquency.sourceRefs[0], '4.11', { unit: 'PERCENT', asOfDate: env.asOf }, tx)).ok, false, 'um valor diferente não reconcilia');
  });
});

test('m9d640 rent.delinquency (CRITICAL) tem detalhe paginado que abre as entradas da base da taxa', async () => {
  const settings = { leaseTypes: ['LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'], windowDays: 90 };
  await kit.inTx(env.cX, {}, async (tx) => {
    const ctx = { ...kit.ctxOf(env.cX), permissions: ['analytics:read', 'analytics:drilldown', 'finance:read', 'legal:read'] };
    const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, 'rent.delinquency', { filter: rentalPortfolioFilterOf('rent.delinquency', env.asOf, settings), unit: 'PERCENT' }, tx);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'rent.delinquency', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(body.reconcileMode, 'RECOMPUTE');
    assert.equal(rows.length, ref.count);
    assert.equal(rows.length, 3);
  });
});

test('m9d640 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas', async () => {
  await kit.inTx(env.cX, { writer: false }, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of Object.keys(EXPECT)) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
      const [[g]] = await kit.sequelize.query('SELECT d.criticality, d.drilldown_enabled, v.version, v.formula_id FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = :code', { replacements: { code }, transaction: tx });
      assert.deepEqual(g, { criticality: EXPECT[code].critical ? 'CRITICAL' : 'NORMAL', drilldown_enabled: EXPECT[code].critical, version: 1, formula_id: code });
    }
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d640 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['rentActiveContracts.js', 'rentVacancy.js', 'rentDelinquency.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biLocacaoCarteiraKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.locacao.faixas_valor_aluguel']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_LOCACAO_CARTEIRA_KPI_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
