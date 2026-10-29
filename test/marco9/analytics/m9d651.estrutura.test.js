'use strict';

// M9-D651 — registro dos três KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, origem e
// detalhe (reconciliação), semente do registry e regras estáticas (Front sem cálculo de KPI, arquivos pequenos, fórmulas puras).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bi = require('../_helpers/obraKpiEnv');
const scenario = require('../_helpers/m9d651Scenario');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { sourceFilter } = require('../../../src/features/analytics/metrics/kpis/obras/filters');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');
require('../../../src/features/analytics');

const API = path.join(__dirname, '..', '..', '..');
const CODES = ['obra.delays', 'obra.measurements', 'obra.nonconformities'];
const WANT = {
  'obra.delays': { unit: 'COUNT', model: 'rm_project_delays', critical: true, dimensions: ['empresa', 'obra', 'etapa', 'equipe'], mode: 'SCHEDULE' },
  'obra.measurements': { unit: 'BRL', model: 'rm_project_measurements', critical: true, dimensions: ['empresa', 'obra', 'etapa', 'fornecedor'], mode: 'EVENT' },
  'obra.nonconformities': { unit: 'COUNT', model: 'rm_project_nonconformities', critical: false, dimensions: ['empresa', 'obra', 'etapa', 'causa', 'equipe'], mode: 'EVENT' },
};
let env;
before(async () => {
  env = await bi.setup();
  await bi.setSetting(env, env.tenantA, 'analytics.owner.obra.measurements', 'Controladoria (papel controller)');
  await scenario.seedAll(env, env.tenantA);
});
after(() => bi.teardown(env));

for (const code of CODES) {
  test(`m9d651 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const w = WANT[code];
    const d = await bi.definitionOf(env, env.tenantA, code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, w.unit, code, w.model, 'CONSTRUCTION', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, w.dimensions);
    assert.equal(d.owner_role, code === 'obra.measurements' ? 'Controladoria (papel controller)' : 'Diretoria de Obras (papel obras-gestor)', 'owner padrão da demanda ou o parâmetro da empresa');
    assert.equal(d.refresh_policy.mode, w.mode);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length > 0);
    assert.equal(d.criticality, w.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, w.critical);
    assert.equal(registry.getFormulaCatalog().has(code), true);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(SETTINGS_SCHEMA['analytics.qualidade.max_sem_causa_pct'], 'o limite de não conformidade sem causa é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'tem especificação de origem');
  });
}

test('m9d651 a origem dos KPIs CRITICAL reconcilia com o valor do KPI no modo do tipo (COUNT em atrasos, SUM em medições)', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    const ctx = bi.ctxOf(env.tenantA);
    for (const [code, unit, mode] of [['obra.delays', 'COUNT', 'COUNT'], ['obra.measurements', 'BRL', 'SUM']]) {
      const kpi = await bi.readKpi(env.tenantA, code);
      const { sourceRefs: [ref], reconcileMode } = await registry.buildSourceRefs(ctx, code, { filter: sourceFilter(code, bi.AS_OF), unit }, tx);
      assert.equal(reconcileMode, mode);
      const r = await registry.reconcileDetail(ctx, code, ref, kpi.value, { unit }, tx);
      assert.equal(r.ok, true, `${code}: detalhe ${r.detail} x KPI ${r.kpi}`);
    }
  });
});

test('m9d651 os KPIs CRITICAL têm detalhe paginado cuja soma ou contagem bate com o valor do KPI', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    const ctx = bi.ctxOf(env.tenantA, ['analytics:read', 'analytics:drilldown', 'construction:read']);
    for (const [code, unit, count] of [['obra.delays', 'COUNT', 3], ['obra.measurements', 'BRL', 4]]) {
      const { sourceRefs: [ref] } = await registry.buildSourceRefs(ctx, code, { filter: sourceFilter(code, bi.AS_OF), unit }, tx);
      const rows = [];
      let page = 1;
      let body;
      do {
        body = await openDrilldown(ctx, { metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
        rows.push(...body.rows);
        page += 1;
      } while (page <= body.totalPages);
      assert.equal(rows.length, count, `${code}: todas as páginas juntas devolvem todas as linhas do filtro`);
      assert.equal(money.cmp(money.sum(rows.map((r) => r.contribution)), (await bi.readKpi(env.tenantA, code)).value), 0, code);
    }
  });
});

test('m9d651 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas', async () => {
  await bi.inTx(env.tenantA, {}, async (tx) => {
    await bi.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx);
    for (const code of CODES) {
      assert.ok(out.published.includes(code) || out.existing.includes(code), `${code} saiu PUBLISHED v1 da semente: ${JSON.stringify(out.pending.filter((p) => p.metricCode === code))}`);
      assert.equal(out.pending.some((p) => p.metricCode === code), false, code);
    }
    throw Object.assign(new Error('rollback'), { rollback: true });
  }).catch((e) => { if (!e.rollback) throw e; });
});

test('m9d651 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e os arquivos têm até 400 linhas', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['obraDelays.js', 'obraMeasurements.js', 'obraNonconformities.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biObrasOperacaoGroups.js'), 'utf8');
  for (const code of CODES) assert.ok(group.includes(`analytics.owner.${code}`), code);
  assert.ok(group.includes('analytics.qualidade.max_sem_causa_pct'));
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
