'use strict';

// M9-D623 — registro dos quatro KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e
// detalhe (reconciliação), semente do registry e regras estáticas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d623Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi } = envK;
const API = path.join(__dirname, '..', '..', '..');
const CODES = ['fin.sector_margin', 'fin.commissions_provisioned', 'fin.commissions_paid', 'fin.owner_repasses_pending'];
const EXPECT = {
  'fin.sector_margin': { model: 'rm_finance_sector_margin', nature: 'ACTUAL', dimensions: ['empresa', 'centro de resultado', 'mês de competência'] },
  'fin.commissions_provisioned': { model: 'rm_finance_health', nature: 'PLANNED', dimensions: ['empresa', 'corretor', 'tipo de comissão'] },
  'fin.commissions_paid': { model: 'rm_finance_health', nature: 'ACTUAL', dimensions: ['empresa', 'corretor', 'mês'] },
  'fin.owner_repasses_pending': { model: 'rm_finance_health', nature: 'ACTUAL', dimensions: ['empresa', 'proprietário', 'imóvel', 'faixa de atraso'] },
};
let env;
let row;
before(async () => {
  env = await envK.setup();
  const [[{ id: broker }]] = await env.admin.query("SELECT id FROM core.users WHERE status = 'ACTIVE' AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
  await envK.setSetting(env, env.cX, 'analytics.owner.fin.commissions_paid', 'Controladoria (papel controller)');
  await sc.seedMargin(env, env.cX);
  await sc.seedCommissions(env, env.cX, broker);
  await sc.seedRepasses(env, env.cX);
  await sc.refreshMargin(env.cX, [sc.CENTER.locacao, sc.CENTER.vendas]);
  await refresh(env.cX, 'finance.owner_repasse.created');
  await kpis(env.cX);
  row = await envK.healthRow(env, env.cX);
});
after(() => envK.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const code of CODES) {
  test(`m9d623 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, 'BRL', code, EXPECT[code].model, 'FINANCE', 'PUBLISHED', EXPECT[code].nature]);
    assert.deepEqual(d.dimensions, EXPECT[code].dimensions);
    assert.equal(d.owner_role, code === 'fin.commissions_paid' ? 'Controladoria (papel controller)' : 'Diretoria Financeira (papel financeiro-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.maxStalenessMinutes, 15);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, code === 'fin.owner_repasses_pending' ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, code === 'fin.owner_repasses_pending');
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
  });
}

test('m9d623 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_sem_setor_pct'], { type: 'number', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.repasse.dias_alerta'], { type: 'integer', min: 1, max: 90 });
  const validate = SETTINGS_SCHEMA['analytics.repasse.faixas_atraso_dias'].validate;
  assert.doesNotThrow(() => validate('k', '5,15'));
  for (const bad of ['15,5', '5', '5,15,30', 'a,b', '5,5', '']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
});

test('m9d623 a origem dos quatro KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo (SUM)', async () => {
  const expected = { 'fin.sector_margin': '66500.00', 'fin.commissions_provisioned': '21000.00', 'fin.commissions_paid': '18000.00', 'fin.owner_repasses_pending': '54000.00' };
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = envK.ctxOf(env.cX);
    for (const code of CODES) {
      assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
      assert.ok(row.source_criteria[code], `${code} tem critério guardado no read model`);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: row.source_criteria[code], unit: 'BRL' }, tx);
      assert.equal(reconcileMode, 'SUM');
      const r = await registry.reconcileDetail(ctx, code, ref, expected[code], { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d623 fin.owner_repasses_pending (CRITICAL) tem detalhe paginado cuja soma bate com o valor do KPI', async () => {
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = { ...envK.ctxOf(env.cX), permissions: ['analytics:read', 'analytics:drilldown', 'finance:read'] };
    const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, 'fin.owner_repasses_pending', { filter: row.source_criteria['fin.owner_repasses_pending'], unit: 'BRL' }, tx);
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: 'fin.owner_repasses_pending', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 1, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    assert.equal(rows.length, 2);
    assert.equal(money.cmp(money.sum(rows.map((r) => r.contribution)), (await readKpi(env.cX, 'fin.owner_repasses_pending')).value), 0);
  });
});

test('m9d623 a semente do registry publica a versão 1 dos quatro KPIs com o catálogo REAL de fórmulas', async () => {
  await envK.inTx(env.cX, { writer: false }, async (tx) => {
    await envK.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    const [[g]] = await envK.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version, v.value_nature FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = 'fin.owner_repasses_pending'", { transaction: tx });
    assert.deepEqual(g, { criticality: 'CRITICAL', drilldown_enabled: true, version: 1, value_nature: 'ACTUAL' });
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d623 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['finSectorMargin.js', 'finCommissionsProvisioned.js', 'finCommissionsPaid.js', 'finOwnerRepassesPending.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFinanceiroResultadosGroups.js'), 'utf8');
  for (const key of [...CODES.map((c) => `analytics.owner.${c}`), 'analytics.qualidade.max_sem_setor_pct', 'analytics.repasse.dias_alerta', 'analytics.repasse.faixas_atraso_dias']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_FINANCEIRO_RESULTADOS_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
