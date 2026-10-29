'use strict';

// M9-D632 — estrutura: colunas novas dos read models, os 5 KPIs no registry (versão 1, 15 campos), semente da M9-D712, parâmetros do administrador, Front sem
// conta e arquivos de fórmula no catálogo. Banco descartável.
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../_helpers/m9d632Env');
const { getFormulaCatalog, runFormulaTests } = require('../../../src/features/analytics/metrics/formulaCatalog');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { seedMetricRegistry } = require('../../../src/features/analytics/metrics/seed/seed.service');
const { getCriticalityRow } = require('../../../src/features/analytics/metrics/seed/criticality.table');
const { COMMERCIAL_DEFINITIONS } = require('../../../src/features/analytics/metrics/kpis/commercial');
const { parseBands, readComercialParams } = require('../../../src/features/analytics/read-models/comercial.settings');

const CODES = ['crm.visits', 'crm.proposals', 'prop.active_properties', 'prop.without_sale_by_period', 'prop.price_changes'];
let env;
before(async () => { env = await sc.setup(); });
after(() => sc.teardown(env));

test('m9d632 os read models ganharam as colunas do KPI sem perder as da M9-D616', async () => {
  const want = {
    rm_crm_visits_proposals: ['visits_scheduled', 'visits_done', 'proposals_sent', 'proposals_accepted', 'visits_no_broker', 'visits_by_broker', 'proposals_sent_accepted', 'proposals_sent_rejected', 'proposals_sent_expired', 'proposals_sent_open', 'proposals_sent_value', 'proposals_sent_no_value', 'proposals_by_broker'],
    rm_property_portfolio: ['status', 'no_sale_days_bucket', 'active_count', 'sale_count', 'rent_count', 'sale_published_count', 'by_type'],
    rm_property_price_changes: ['changes', 'change_pct_sum', 'avg_change_pct', 'with_prior', 'by_broker', 'by_type'],
  };
  for (const [table, columns] of Object.entries(want)) {
    const [rows] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } });
    const have = rows.map((r) => r.column_name);
    for (const c of columns) assert.ok(have.includes(c), `${table}: falta ${c}`);
  }
});

test('m9d632 as cinco fórmulas estão no catálogo com id igual ao código, versão 1 e testes que passam', () => {
  const catalog = getFormulaCatalog();
  for (const code of CODES) {
    const f = catalog.get(code);
    assert.ok(f, `${code} no catálogo`);
    assert.equal(f.version, 1);
    const r = runFormulaTests(f);
    assert.equal(r.ok, true, `${code}: ${JSON.stringify(r.failures)}`);
    assert.ok(r.total >= 5, `${code}: pelo menos 5 casos`);
  }
});

test('m9d632 cada KPI existe no registry da empresa com versão 1 e os campos do livro', async () => {
  await sc.kpis(env.cX);
  for (const code of CODES) {
    const def = COMMERCIAL_DEFINITIONS.find((d) => d.metricCode === code);
    const [[row]] = await env.admin.query(
      `SELECT d.status, d.criticality, d.drilldown_enabled, d.owner_role, d.domain, v.version, v.unit, v.formula_id, v.formula_semantic, v.source_read_model, v.dimensions, v.refresh_policy, v.quality_rule, v.value_nature
         FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }
    );
    const table = getCriticalityRow(code);
    assert.equal(row.version, 1, code);
    assert.equal(row.status, 'PUBLISHED', code);
    assert.equal(row.formula_id, code, 'fórmula versionada no código: id igual ao código do indicador');
    assert.equal(row.unit, table.unit, code);
    assert.equal(row.criticality, table.criticality, code);
    assert.equal(row.drilldown_enabled, table.criticality === 'CRITICAL', `${code}: o drill-down liga nos CRITICAL`);
    assert.equal(row.source_read_model, table.sourceReadModel, code);
    assert.deepEqual(row.dimensions, table.dimensions, `${code}: dimensões do livro`);
    assert.deepEqual(row.refresh_policy, table.refreshPolicy, `${code}: periodicidade do livro`);
    assert.equal(row.owner_role, 'Gerência Comercial (papel comercial-gestor)', `${code}: owner padrão`);
    assert.ok(row.formula_semantic.length > 80 && row.quality_rule.referenceReport && Array.isArray(row.quality_rule.requiredFields), `${code}: fórmula e regra de qualidade escritas`);
    assert.equal(def.sourceReadModel, row.source_read_model);
  }
});

test('m9d632 o owner do KPI segue o parâmetro analytics.owner.<código> da empresa', async () => {
  await sc.setSetting(env, env.cY, 'analytics.owner.crm.visits', 'Diretoria Comercial (papel diretor)');
  await sc.kpis(env.cY, { only: ['crm.visits'] });
  const [[row]] = await env.admin.query("SELECT owner_role FROM analytics.metric_definitions WHERE company_id = :c AND metric_code = 'crm.visits'", { replacements: { c: env.cY.companyId } });
  assert.equal(row.owner_role, 'Diretoria Comercial (papel diretor)');
  for (const code of CODES) assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], `${code}: parâmetro de owner no painel`);
});

test('m9d632 a semente do registry publica a versão 1 dos cinco KPIs com a fórmula e o read model existentes', async () => {
  const result = await sc.inTx(env.cX, {}, async (tx) => seedMetricRegistry({ actorUserId: env.cX.userId, permissions: ['analytics:manage'] }, tx));
  for (const code of CODES) {
    assert.ok(result.published.includes(code) || result.existing.includes(code), `${code} publicado pela semente`);
    assert.ok(!result.pending.some((p) => p.metricCode === code), `${code} não ficou pendente`);
  }
});

test('m9d632 as faixas de imóvel sem venda têm o padrão do livro e são parâmetro', async () => {
  const params = await sc.inTx(env.cX, {}, (tx) => readComercialParams(env.cX, tx));
  assert.deepEqual(params.bands, [30, 90, 180], '0-30, 31-90, 91-180 e 181+');
  assert.deepEqual(parseBands('15,45'), [15, 45]);
  assert.ok(SETTINGS_SCHEMA['analytics.imoveis.faixas_sem_venda_dias']);
});

test('m9d632 nenhum KPI desta demanda é calculado no Front', () => {
  const root = path.join(__dirname, '../../../../NayaraOne--FRONT');
  if (!fs.existsSync(root)) return;
  const fields = /(visits_scheduled|visits_done|proposals_sent|proposals_accepted|sale_published_count|change_pct_sum|avg_change_pct|visits_no_broker)/;
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
