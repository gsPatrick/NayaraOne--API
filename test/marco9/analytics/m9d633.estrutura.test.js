'use strict';

// M9-D633 — estrutura e worker: colunas novas dos read models do Radar e dos corretores, os 3 KPIs no registry (versão 1, 15 campos), a semente da M9-D712, os
// parâmetros do administrador e o rebuild igual ao incremental. Banco descartável.
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d633Scenario');
const asserts = require('../_helpers/readModelAsserts');
const { getFormulaCatalog, runFormulaTests } = require('../../../src/features/analytics/metrics/formulaCatalog');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { seedMetricRegistry } = require('../../../src/features/analytics/metrics/seed/seed.service');
const { getCriticalityRow } = require('../../../src/features/analytics/metrics/seed/criticality.table');
const { readCorretoresKpiParams } = require('../../../src/features/analytics/read-models/corretoresKpi.settings');

const { makeEvent, apply, rows } = sc;
const CODES = ['radar.matches', 'crm.broker_capture', 'crm.broker_conversion'];
const ana = sc.src.uuid();
const bruno = sc.src.uuid();
let env;
before(async () => {
  env = await sc.setup();
  await sc.setSetting(env, env.cX, 'analytics.qualidade.max_nulos_pct.created_by', 10);
  await sc.seedRadar(env, env.cX, ana, bruno);
  await sc.seedCapture(env, env.cX, ana, bruno);
  await sc.seedClosed(env, env.cX, ana, bruno);
});
after(() => sc.teardown(env));

test('m9d633 os read models ganharam as colunas do KPI sem perder as da M9-D616', async () => {
  const want = {
    rm_radar_matches: ['day', 'matches', 'converted', 'converted_visit_opp', 'sent', 'invalid', 'by_origin', 'by_broker'],
    rm_broker_performance: ['broker_id', 'month', 'captured', 'leads_assigned', 'won', 'lost', 'captured_with_value', 'captured_value_sum'],
  };
  for (const [table, columns] of Object.entries(want)) {
    const [list] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } });
    for (const c of columns) assert.ok(list.map((r) => r.column_name).includes(c), `${table}: falta ${c}`);
  }
});

test('m9d633 as três fórmulas estão no catálogo com id igual ao código, versão 1 e testes que passam', () => {
  for (const code of CODES) {
    const f = getFormulaCatalog().get(code);
    assert.ok(f, `${code} no catálogo`);
    assert.equal(f.version, 1);
    const r = runFormulaTests(f);
    assert.equal(r.ok, true, `${code}: ${JSON.stringify(r.failures)}`);
    assert.ok(r.total >= 5);
  }
});

test('m9d633 cada KPI existe no registry da empresa com versão 1 e os campos do livro', async () => {
  await sc.refreshModels(env.cX, ['rm_radar_matches', 'rm_broker_performance']);
  await sc.kpis(env.cX);
  for (const code of CODES) {
    const [[row]] = await env.admin.query(
      `SELECT d.status, d.criticality, d.drilldown_enabled, d.owner_role, v.version, v.unit, v.formula_id, v.formula_semantic, v.source_read_model, v.dimensions, v.refresh_policy, v.quality_rule
         FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }
    );
    const table = getCriticalityRow(code);
    assert.deepEqual([row.version, row.status, row.formula_id, row.unit, row.criticality], [1, 'PUBLISHED', code, table.unit, table.criticality], code);
    assert.equal(row.drilldown_enabled, table.criticality === 'CRITICAL', code);
    assert.deepEqual([row.source_read_model, row.dimensions, row.refresh_policy], [table.sourceReadModel, table.dimensions, table.refreshPolicy], code);
    assert.equal(row.owner_role, 'Gerência Comercial (papel comercial-gestor)', `${code}: owner padrão`);
    assert.ok(row.formula_semantic.length > 80 && row.quality_rule.referenceReport && Array.isArray(row.quality_rule.requiredFields), code);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], `${code}: parâmetro de owner no painel`);
  }
});

test('m9d633 a semente do registry publica a versão 1 dos três KPIs com a fórmula e o read model existentes', async () => {
  const result = await sc.inTx(env.cX, {}, (tx) => seedMetricRegistry({ actorUserId: env.cX.userId, permissions: ['analytics:manage'] }, tx));
  for (const code of CODES) {
    assert.ok(result.published.includes(code) || result.existing.includes(code), `${code} publicado pela semente`);
    assert.ok(!result.pending.some((p) => p.metricCode === code), `${code} não ficou pendente`);
  }
});

test('m9d633 os limites de qualidade são parâmetros do administrador com o padrão do livro', async () => {
  const params = await sc.inTx(env.cY, {}, (tx) => readCorretoresKpiParams(env.cY, tx));
  assert.deepEqual(params, { maxNoBrokerPct: 5, minSample: 5 });
  assert.ok(SETTINGS_SCHEMA['analytics.qualidade.max_sem_corretor_pct'] && SETTINGS_SCHEMA['analytics.qualidade.min_amostra']);
  await sc.setSetting(env, env.cY, 'analytics.qualidade.max_sem_corretor_pct', 12);
  assert.equal((await sc.inTx(env.cY, {}, (tx) => readCorretoresKpiParams(env.cY, tx))).maxNoBrokerPct, 12);
});

test('m9d633 nenhum KPI desta demanda é calculado no Front', () => {
  const root = path.join(__dirname, '../../../../NayaraOne--FRONT');
  if (!fs.existsSync(root)) return;
  const fields = /(converted_visit_opp|captured_value_sum|captured_with_value)/;
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', 'e2e', 'public'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && fields.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
    }
  };
  for (const dir of ['app', 'components', 'lib']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  assert.deepEqual(hits, [], 'o Front recebe o número pronto: nenhum arquivo cita os campos de soma e divisão do read model');
});

for (const model of ['rm_radar_matches', 'rm_broker_performance']) {
  test(`m9d633 ${model}: o rebuild reproduz o incremental`, async () => {
    const readModels = require('../../../src/features/analytics/read-models');
    const ctx = { groupId: env.cX.groupId, actorUserId: env.cX.userId, permissions: ['analytics:rebuild'], reason: 'Teste: tabela apagada e reconstruída da fonte.' };
    const [opps] = await env.admin.query("SELECT id FROM crm.opportunities WHERE company_id = :c AND stage IN ('CLOSED_WON', 'CLOSED_LOST')", { replacements: { c: env.cX.companyId } });
    const [props] = await env.admin.query('SELECT id FROM real_estate.properties WHERE company_id = :c', { replacements: { c: env.cX.companyId } });
    const days = ['2026-09-20', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-12', '2026-10-13', '2026-10-28', '2026-10-29'];
    await asserts.assertRebuildEqualsIncremental({
      buildIncremental: async () => {
        for (const day of days) await apply(env.cX, makeEvent(env.cX, 'radar.matched', { radarId: sc.src.uuid() }, { occurredAt: new Date(`${day}T15:00:00Z`) }));
        for (const o of opps) await apply(env.cX, makeEvent(env.cX, 'crm.opportunity.lost', { id: o.id }));
        for (const p of props) await apply(env.cX, makeEvent(env.cX, 'property.created', { id: p.id }));
      },
      readRows: () => rows(env, model, env.cX),
      wipe: () => env.admin.query(`DELETE FROM analytics.${model} WHERE company_id = :c`, { replacements: { c: env.cX.companyId } }),
      rebuild: async () => { const r = await readModels.rebuildReadModel(ctx, { model, companyId: env.cX.companyId }); assert.equal(r.status, 'SUCCEEDED', model); },
    });
  });
}
