'use strict';

// M9-D631 — definição dos quatro KPIs no registry, semente, parâmetros do administrador, replay do evento, detalhe (drill-down) do indicador CRITICAL e as
// regras estáticas (Front não calcula, fórmulas puras, nenhum arquivo acima de 400 linhas). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/crmKpiEnv');
const asserts = require('../_helpers/readModelAsserts');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const seed = require('../../../src/features/analytics/metrics/seed');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const { buildCrmKpiEntries } = require('../../../src/features/analytics/metrics/kpis');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs do funil ao fim do refresh

const { src, at, opp, TODAY, registry } = kit;
const API = path.join(__dirname, '..', '..', '..');
const MINE = ['crm.opportunities_by_stage', 'crm.conversion_rate', 'crm.loss_reasons', 'crm.portfolio_without_next_action'];
let env;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

const definition = async (t, code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } }))[0][0];

async function scenario(t) {
  const broker = src.uuid();
  const ids = [];
  const closed = {};
  for (let i = 0; i < 3; i += 1) ids.push(await opp(env, t, { owner: broker, stage: 'NEW', created: at(2), updated: at(27), nextAction: 'Ligar', nextActionDueAt: '2026-11-05T15:00:00Z' }));
  ids.push(await opp(env, t, { owner: broker, stage: 'VISIT_SCHEDULED', created: at(2), updated: at(20) }));
  for (const [stage, day] of [['WON', 10], ['LOST', 11]]) {
    const id = await opp(env, t, { owner: broker, stage, created: at(2), closedAt: at(day), lostReason: 'PRICE' });
    ids.push(id);
    closed[id] = stage === 'WON' ? 'won' : 'lost';
  }
  await kit.refreshAll(t, ids, closed);
  return { ids, closed, broker };
}

test('m9d631 os quatro KPIs existem no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.owner.crm.conversion_rate', 'Diretoria Comercial (papel diretor-comercial)');
  await scenario(t);
  await kit.kpis(t);
  const expected = {
    'crm.opportunities_by_stage': ['COUNT', 'rm_crm_opportunity_stage', 'CRITICAL', ['empresa', 'estágio', 'corretor', 'origem'], 'SCHEDULE'],
    'crm.conversion_rate': ['PERCENT', 'rm_crm_outcome', 'NORMAL', ['empresa', 'origem', 'corretor', 'período'], 'EVENT'],
    'crm.loss_reasons': ['COUNT', 'rm_crm_outcome', 'NORMAL', ['empresa', 'motivo', 'corretor', 'origem'], 'EVENT'],
    'crm.portfolio_without_next_action': ['COUNT', 'rm_crm_next_action', 'NORMAL', ['empresa', 'corretor', 'estágio'], 'SCHEDULE'],
  };
  for (const [code, [unit, model, criticality, dimensions, mode]] of Object.entries(expected)) {
    const d = await definition(t, code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature, d.criticality, d.refresh_policy.mode], [1, unit, code, model, 'CRM', 'PUBLISHED', 'ACTUAL', criticality, mode], code);
    assert.deepEqual(d.dimensions, dimensions, code);
    assert.ok(d.quality_rule.referenceReport, code);
    assert.equal(d.drilldown_enabled, criticality === 'CRITICAL', `${code}: só o CRITICAL nasce com detalhe habilitado`);
    assert.equal(registry.getFormulaCatalog().has(code), true, `${code} existe no catálogo de fórmulas`);
    assert.ok(registry.getSourceSpec(code), `${code} tem especificação de origem`);
  }
  assert.equal((await definition(t, 'crm.loss_reasons')).owner_role, 'Gerência Comercial (papel comercial-gestor)', 'owner padrão da demanda');
  assert.equal((await definition(t, 'crm.conversion_rate')).owner_role, 'Diretoria Comercial (papel diretor-comercial)', 'o owner vem do parâmetro analytics.owner.crm.conversion_rate');
  assert.deepEqual(await registry.findInconsistentMetrics(null), [], 'toda métrica publicada aponta fórmula que existe no código');
});

test('m9d631 a semente do registry publica a versão 1 dos quatro KPIs com a fórmula do código e o read model existente', async () => {
  const rows = seed.listCriticalityRows().filter((r) => MINE.includes(r.code));
  assert.equal(rows.length, 4);
  await kit.inTx(env.tenantA, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx, { rows });
    assert.deepEqual(out.pending, [], JSON.stringify(out.pending));
    assert.deepEqual([...out.published, ...out.existing].sort(), [...MINE].sort());
  });
});

test('m9d631 os parâmetros existem no SETTINGS_SCHEMA, rejeitam valor inválido e a ordem dos estágios é lida', async () => {
  for (const code of MINE) assert.equal(SETTINGS_SCHEMA[`analytics.owner.${code}`].type, 'string', code);
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_sem_motivo_pct'], { type: 'integer', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.comercial.proxima_acao_inclui_hoje'], { type: 'boolean' });
  const validate = SETTINGS_SCHEMA['analytics.comercial.ordem_estagios'].validate;
  assert.doesNotThrow(() => validate('k', 'NEW,QUALIFIED,PROPOSAL'));
  for (const bad of ['', 'NEW,NEW', 'NEW,,X', '1ABC', 'new stage']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.comercial.ordem_estagios', 'VISIT_SCHEDULED,NEW,LOST,WON');
  const entries = await kit.inTx(t, {}, (tx) => buildCrmKpiEntries({ companyId: t.companyId, groupId: t.groupId }, TODAY, tx));
  const stages = entries.find((e) => e.code === 'crm.opportunities_by_stage').result.details.stages.map((s) => s.stage);
  assert.deepEqual(stages, ['VISIT_SCHEDULED', 'NEW', 'LOST', 'WON', 'WITHDRAWN'], 'a ordem do administrador vale; o que ficou fora vai depois');
});

test('m9d631 replay do mesmo evento não altera o valor', async () => { // helper compartilhado assertReplayIdempotent (M9-D607)
  const t = env.cX;
  const id = await opp(env, t, { owner: src.uuid(), stage: 'WON', created: at(2), closedAt: at(12) });
  const event = kit.makeEvent(t, 'crm.opportunity.won', { id });
  const readRows = async () => [...await kit.rows(env, 'rm_crm_outcome', t), ...await kit.rows(env, 'rm_crm_opportunity_stage', t), ...await kit.rows(env, 'rm_crm_next_action', t)];
  await asserts.assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow: readRows });
  await kit.kpis(t);
  const k = await kit.readKpi(t, 'crm.conversion_rate');
  await kit.apply(t, event);
  assert.equal((await kit.kpis(t)).written, 0, 'o replay não cria revisão nova');
  assert.equal((await kit.readKpi(t, 'crm.conversion_rate')).revisionNo, k.revisionNo);
});

test('m9d631 crm.opportunities_by_stage (CRITICAL) tem origem e detalhe registrados e o detalhe paginado bate com o valor do KPI', async () => {
  const t = env.cX;
  const kpi = await kit.readKpi(t, 'crm.opportunities_by_stage');
  const ref = kpi.sourceRefs[0];
  assert.equal(registry.getSourceSpec('crm.opportunities_by_stage').type, 'OPPORTUNITIES');
  const ctx = kit.ctxOf(t, ['analytics:read', 'analytics:drilldown', 'crm:opportunities:read']);
  const rows = [];
  let page = 1;
  let body;
  await kit.inTx(t, {}, async (tx) => {
    do {
      body = await openDrilldown(ctx, { metricCode: 'crm.opportunities_by_stage', filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 4, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
  });
  assert.equal(body.reconcileMode, 'COUNT');
  assert.equal(rows.length, Number(kpi.value), 'as páginas juntas devolvem exatamente as oportunidades contadas');
  assert.equal(body.aggregate.count, Number(kpi.value));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'nenhuma linha repetida entre páginas');
  assert.ok(rows.every((r) => r.contribution === '1' && 'stage' in r.fields && r.link === '/painel/crm'));
});

test('m9d631 nenhum KPI desta demanda é calculado no Front (guarda de soma/divisão) e as fórmulas são puras', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['crmOpportunitiesByStage.js', 'crmConversionRate.js', 'crmLossReasons.js', 'crmPortfolioWithoutNextAction.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
});

test('m9d631 o Front tem o grupo de parâmetros e nenhum arquivo passa de 400 linhas', () => {
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFunilComercialGroups.js'), 'utf8');
  for (const key of ['"opportunities_by_stage"', '"conversion_rate"', '"loss_reasons"', '"portfolio_without_next_action"', 'analytics.qualidade.max_sem_motivo_pct', 'analytics.qualidade.max_oportunidade_sem_corretor_pct', 'analytics.comercial.ordem_estagios', 'analytics.comercial.proxima_acao_inclui_hoje']) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
