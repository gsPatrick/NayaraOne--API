'use strict';

// M9-D630 — definição dos dois KPIs no registry, semente do registry, parâmetros do administrador, replay do evento, ligação automática ao refresh
// e as regras estáticas (Front não calcula, fórmulas puras, nenhum arquivo acima de 400 linhas). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/crmKpiEnv');
const asserts = require('../_helpers/readModelAsserts');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const readModels = require('../../../src/features/analytics/read-models');
const seed = require('../../../src/features/analytics/metrics/seed');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs do funil ao fim do refresh

const { src, at, TODAY, registry } = kit;
const API = path.join(__dirname, '..', '..', '..');
const MINE = ['crm.leads_by_origin', 'crm.first_response_time'];
let env;
before(async () => { env = await kit.setup(); });
after(() => kit.teardown(env));

const definition = async (t, code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } }))[0][0];

test('m9d630 os dois KPIs existem no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.owner.crm.first_response_time', 'Atendimento (papel atendimento-gestor)');
  const id = await src.opportunity(env, t, { owner: src.uuid(), source: 'SITE', created: at(5) });
  await kit.refresh(t, id);
  await kit.kpis(t);
  const leads = await definition(t, 'crm.leads_by_origin');
  assert.deepEqual([leads.version, leads.unit, leads.formula_id, leads.source_read_model, leads.domain, leads.status, leads.value_nature, leads.criticality],
    [1, 'COUNT', 'crm.leads_by_origin', 'rm_crm_lead_daily', 'CRM', 'PUBLISHED', 'ACTUAL', 'NORMAL']);
  assert.deepEqual(leads.dimensions, ['empresa', 'origem', 'corretor', 'período']);
  assert.equal(leads.owner_role, 'Gerência Comercial (papel comercial-gestor)', 'owner padrão da demanda');
  assert.deepEqual([leads.refresh_policy.mode, leads.refresh_policy.maxStalenessMinutes], ['EVENT', 15]);
  assert.ok(leads.quality_rule.referenceReport);
  const first = await definition(t, 'crm.first_response_time');
  assert.deepEqual([first.version, first.unit, first.formula_id, first.source_read_model, first.criticality], [1, 'MINUTES', 'crm.first_response_time', 'rm_crm_lead_daily', 'NORMAL']);
  assert.deepEqual(first.dimensions, ['empresa', 'origem', 'corretor']);
  assert.equal(first.owner_role, 'Atendimento (papel atendimento-gestor)', 'o owner vem do parâmetro analytics.owner.crm.first_response_time');
  assert.equal(first.refresh_policy.mode, 'SCHEDULE');
  assert.equal(first.refresh_policy.cron, '5 0 * * *', 'job às 00:05');
  for (const code of MINE) assert.equal(registry.getFormulaCatalog().has(code), true, `${code} existe no catálogo de fórmulas`);
  assert.deepEqual(await registry.findInconsistentMetrics(null), [], 'toda métrica publicada aponta fórmula que existe no código');
});

test('m9d630 a semente do registry publica a versão 1 dos dois KPIs com a fórmula do código e o read model existente', async () => {
  const rows = seed.listCriticalityRows().filter((r) => MINE.includes(r.code));
  assert.equal(rows.length, 2);
  await kit.inTx(env.tenantA, {}, async (tx) => {
    await kit.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    const out = await seed.seedMetricRegistry({ groupId: null, companyId: null, actorUserId: null, permissions: ['analytics:manage'] }, tx, { rows });
    assert.deepEqual(out.pending, [], JSON.stringify(out.pending));
    assert.deepEqual([...out.published, ...out.existing].sort(), [...MINE].sort());
  });
});

test('m9d630 os parâmetros existem no SETTINGS_SCHEMA e rejeitam valor inválido', () => {
  for (const key of ['analytics.owner.crm.leads_by_origin', 'analytics.owner.crm.first_response_time']) assert.equal(SETTINGS_SCHEMA[key].type, 'string', key);
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.max_origem_vazia_pct'], { type: 'integer', min: 0, max: 100 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.qualidade.min_amostra'], { type: 'integer', min: 1, max: 1000 });
  assert.deepEqual(SETTINGS_SCHEMA['analytics.comercial.primeira_resposta_inclui_nay'], { type: 'boolean' });
  const { CRM_KPI_DEFAULTS } = require('../../../src/features/analytics/read-models/crmKpi.settings');
  assert.deepEqual([CRM_KPI_DEFAULTS['analytics.qualidade.max_origem_vazia_pct'], CRM_KPI_DEFAULTS['analytics.qualidade.min_amostra']], [5, 5], 'padrões do livro da demanda');
});

test('m9d630 replay do mesmo evento não altera o valor (helper compartilhado assertReplayIdempotent)', async () => {
  const t = env.cX;
  const id = await src.opportunity(env, t, { owner: src.uuid(), source: 'PORTAL', created: at(6) });
  const event = kit.created(t, id);
  const readRow = () => kit.rows(env, 'rm_crm_lead_daily', t);
  await asserts.assertReplayIdempotent({ applyEvent: () => kit.apply(t, event), readRow });
  const before = await kit.kpis(t);
  const again = await kit.kpis(t);
  assert.equal(again.written, 0, 'recalcular sem mudança no read model não grava revisão nova');
  assert.equal(again.kpis['crm.leads_by_origin'].value, before.kpis['crm.leads_by_origin'].value);
  const k = await kit.readKpi(t, 'crm.leads_by_origin');
  assert.equal(k.revisionNo >= 1, true);
  await kit.apply(t, event); // o mesmo evento outra vez
  assert.equal((await kit.kpis(t)).written, 0, 'replay do evento não altera o valor nem cria revisão');
  assert.equal((await kit.readKpi(t, 'crm.leads_by_origin')).revisionNo, k.revisionNo);
});

test('m9d630 o refresh agendado da empresa grava os snapshots dos KPIs sozinho (ligação ao fim do lote)', async () => {
  const t = env.cY;
  const id = await src.opportunity(env, t, { owner: src.uuid(), source: 'PORTAL', created: at(26) }); // dentro da janela de recálculo da agenda (7 dias)
  await src.message(env, t, { opportunity: id, created: at(26, 12, 5) });
  await kit.inTx(t, { commit: true }, async (tx) => {
    const params = await readModels.readRefreshParams(t, tx);
    await readModels.refreshCompanyScheduled({ companyId: t.companyId, groupId: t.groupId }, params, tx, { now: env.now });
  });
  const k = await kit.readKpi(t, 'crm.leads_by_origin').catch((e) => ({ error: e.code }));
  assert.equal(k.error, undefined, 'o snapshot existe sem chamada manual');
  assert.equal(Number(k.value), 1);
  assert.equal(TODAY, '2026-10-28');
});

test('m9d630 nenhum KPI desta demanda é calculado no Front (guarda de soma/divisão) e as fórmulas são puras', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['crmLeadsByOrigin.js', 'crmFirstResponseTime.js', '_crmKpi.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
});

test('m9d630 o Front tem o grupo de parâmetros e nenhum arquivo passa de 400 linhas', () => {
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biFunilComercialGroups.js'), 'utf8');
  for (const key of ['"leads_by_origin"', '"first_response_time"', 'analytics.owner.crm.', 'analytics.qualidade.max_origem_vazia_pct', 'analytics.qualidade.min_amostra']) assert.ok(group.includes(key), key);
  assert.match(fs.readFileSync(path.join(front, 'BiTab.js'), 'utf8'), /BI_FUNIL_COMERCIAL_GROUPS/);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
