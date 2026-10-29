'use strict';

// M9-D622 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e detalhe
// (reconciliação no modo do tipo), semente do registry e regras estáticas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const envK = require('../_helpers/finKpiEnv');
const sc = require('../_helpers/m9d622Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const { refresh, kpis, readKpi } = envK;
const API = path.join(__dirname, '..', '..', '..');
const CODES = ['fin.overdue_receivables', 'fin.delinquency_rate', 'fin.breathing_need'];
const EXPECT = {
  'fin.overdue_receivables': { unit: 'BRL', nature: 'ACTUAL', dimensions: ['empresa', 'contrato', 'faixa de atraso'] },
  'fin.delinquency_rate': { unit: 'PERCENT', nature: 'ACTUAL', dimensions: ['empresa', 'contrato', 'faixa de atraso'] },
  'fin.breathing_need': { unit: 'BRL', nature: 'PROJECTED', dimensions: ['empresa'] },
};
let env;
let row;
let rowY;
before(async () => {
  env = await envK.setup();
  await envK.setSetting(env, env.cX, 'analytics.owner.fin.delinquency_rate', 'Controladoria (papel controller)');
  await sc.seedOverdue(env, env.cX);
  await sc.seedBreathing(env, env.cY);
  for (const t of [env.cX, env.cY]) {
    await refresh(t);
    await kpis(t);
  }
  row = await envK.healthRow(env, env.cX);
  rowY = await envK.healthRow(env, env.cY);
});
after(() => envK.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const code of CODES) {
  test(`m9d622 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, EXPECT[code].unit, code, 'rm_finance_health', 'FINANCE', 'PUBLISHED', EXPECT[code].nature]);
    assert.deepEqual(d.dimensions, EXPECT[code].dimensions);
    assert.equal(d.owner_role, code === 'fin.delinquency_rate' ? 'Controladoria (papel controller)' : 'Diretoria Financeira (papel financeiro-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.maxStalenessMinutes, 15);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, 'CRITICAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, true);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
  });
}

test('m9d622 o parâmetro das faixas existe no SETTINGS_SCHEMA e rejeita valor inválido', () => {
  const validate = SETTINGS_SCHEMA['analytics.inadimplencia.faixas_atraso_dias'].validate;
  for (const ok of ['30,60,90', '15', '10,20,30,40,50,60']) assert.doesNotThrow(() => validate('k', ok), ok);
  for (const bad of ['90,60', '30,30', 'a,b', '', '0,10', '1,2,3,4,5,6,7', '30;60']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.ok(SETTINGS_SCHEMA['analytics.inadimplencia.janela_dias'], 'a janela da taxa é parâmetro (M9-D615)');
});

test('m9d622 a origem dos KPIs está registrada e o teste de reconciliação do detalhe passa no modo do tipo', async () => {
  const asOf = envK.AS_OF;
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = envK.ctxOf(env.cX);
    for (const code of ['fin.overdue_receivables', 'fin.delinquency_rate']) {
      assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
      assert.ok(row.source_criteria[code], `${code} tem critério guardado no read model`);
    }
    const sum = await registry.buildSourceRefs(ctx, 'fin.overdue_receivables', { filter: row.source_criteria['fin.overdue_receivables'], unit: 'BRL' }, tx);
    assert.equal(sum.reconcileMode, 'SUM');
    const a = await registry.reconcileDetail(ctx, 'fin.overdue_receivables', sum.sourceRefs[0], '25000.00', { unit: 'BRL' }, tx);
    assert.equal(a.ok, true, `detalhe ${a.detail} x KPI ${a.kpi}`);
    const rate = await registry.buildSourceRefs(ctx, 'fin.delinquency_rate', { filter: row.source_criteria['fin.delinquency_rate'], unit: 'PERCENT' }, tx);
    assert.equal(rate.reconcileMode, 'RECOMPUTE');
    assert.equal(rate.sourceRefs[0].count, 4, 'as quatro entradas próprias da janela: duas vencidas, a de hoje e a paga');
    const b = await registry.reconcileDetail(ctx, 'fin.delinquency_rate', rate.sourceRefs[0], '8.00', { unit: 'PERCENT', asOfDate: asOf }, tx);
    assert.equal(b.ok, true, `a taxa refeita sobre as linhas ${b.detail} x KPI ${b.kpi}`);
    const wrong = await registry.reconcileDetail(ctx, 'fin.delinquency_rate', rate.sourceRefs[0], '8.01', { unit: 'PERCENT', asOfDate: asOf }, tx);
    assert.equal(wrong.ok, false, 'um valor diferente não reconcilia');
  });
  await envK.inTx(env.cY, {}, async (tx) => {
    const ctx = envK.ctxOf(env.cY);
    const composite = await registry.buildSourceRefs(ctx, 'fin.breathing_need', { componentFilters: rowY.source_criteria, units: { 'fin.overdue_payables': 'BRL', 'fin.payables_30d': 'BRL', 'fin.commissions_unlinked_30d': 'BRL', 'fin.free_cash': 'BRL' } }, tx);
    const expected = { 'fin.overdue_payables': '6500.00', 'fin.payables_30d': '22000.00', 'fin.commissions_unlinked_30d': '3000.00', 'fin.free_cash': '18000.00' };
    for (const c of composite.components) {
      const r = await registry.reconcileDetail(ctx, c.metricCode, c.sourceRefs[0], expected[c.metricCode], { unit: 'BRL' }, tx);
      assert.equal(r.ok, true, `${c.metricCode}: detalhe ${r.detail} x componente ${r.kpi}`);
    }
  });
});

async function allRows(ctx, tx, code, ref, extra = {}) {
  const rows = [];
  let page = 1;
  let body;
  do {
    body = await openDrilldown(ctx, { metricCode: code, ...extra, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
    rows.push(...body.rows);
    page += 1;
  } while (page <= body.totalPages);
  return { rows, body };
}

test('m9d622 o detalhe paginado dos três KPIs (CRITICAL) devolve linhas cuja soma ou contagem bate com o valor no modo do tipo', async () => {
  await envK.inTx(env.cX, {}, async (tx) => {
    const ctx = { ...envK.ctxOf(env.cX), permissions: ['analytics:read', 'analytics:drilldown', 'finance:read'] };
    const overdue = await registry.buildSourceRefs(ctx, 'fin.overdue_receivables', { filter: row.source_criteria['fin.overdue_receivables'], unit: 'BRL' }, tx);
    const a = await allRows(ctx, tx, 'fin.overdue_receivables', overdue.sourceRefs[0]);
    assert.equal(a.rows.length, 3);
    assert.equal(money.cmp(money.sum(a.rows.map((r) => r.contribution)), (await readKpi(env.cX, 'fin.overdue_receivables')).value), 0, 'a soma do detalhe é o valor inadimplente');
    const rate = await registry.buildSourceRefs(ctx, 'fin.delinquency_rate', { filter: row.source_criteria['fin.delinquency_rate'], unit: 'PERCENT' }, tx);
    const r = await allRows(ctx, tx, 'fin.delinquency_rate', rate.sourceRefs[0]);
    assert.equal(r.rows.length, 4, 'a taxa abre as entradas da base; a conta é refeita sobre elas');
    assert.equal(r.body.reconcileMode, 'RECOMPUTE');
  });
  await envK.inTx(env.cY, {}, async (tx) => {
    const ctx = { ...envK.ctxOf(env.cY), permissions: ['analytics:read', 'analytics:drilldown', 'finance:read'] };
    const composite = await registry.buildSourceRefs(ctx, 'fin.breathing_need', { componentFilters: rowY.source_criteria, units: { 'fin.overdue_payables': 'BRL', 'fin.payables_30d': 'BRL', 'fin.commissions_unlinked_30d': 'BRL', 'fin.free_cash': 'BRL' } }, tx);
    const sums = {};
    for (const c of composite.components) {
      const part = await allRows(ctx, tx, 'fin.breathing_need', c.sourceRefs[0], { component: c.metricCode });
      sums[c.metricCode] = money.money(money.sum(part.rows.map((x) => x.contribution)));
    }
    assert.deepEqual([sums['fin.overdue_payables'], sums['fin.payables_30d'], sums['fin.commissions_unlinked_30d']], ['6500.00', '22000.00', '3000.00']);
    const need = money.sub(money.sum([sums['fin.overdue_payables'], sums['fin.payables_30d'], sums['fin.commissions_unlinked_30d']]), '18000.00');
    assert.equal(money.cmp(need, (await readKpi(env.cY, 'fin.breathing_need')).value), 0, 'os componentes do detalhe refazem o valor da necessidade');
  });
});

test('m9d622 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas', async () => {
  await envK.inTx(env.cX, { writer: false }, async (tx) => {
    await envK.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
      const [[g]] = await envK.sequelize.query("SELECT d.criticality, d.drilldown_enabled, v.version, v.formula_id FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id IS NULL AND d.metric_code = :code", { replacements: { code }, transaction: tx });
      assert.deepEqual(g, { criticality: 'CRITICAL', drilldown_enabled: true, version: 1, formula_id: code });
    }
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d622 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['finOverdueReceivables.js', 'finDelinquencyRate.js', 'finBreathingNeed.js', '_delinquency.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFinanceiroInadimplenciaGroups.js'), 'utf8');
  for (const key of [...CODES.map((c) => `analytics.owner.${c}`), 'analytics.inadimplencia.faixas_atraso_dias']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_FINANCEIRO_INADIMPLENCIA_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
