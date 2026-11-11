'use strict';

// M9-D680 — registro dos seis KPIs (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade), parâmetros do administrador, semente do registry, origem e detalhe do CRITICAL
// e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo, todo parâmetro lido).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d680Env');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { TECH_KPI_DEFAULTS, KEYS } = require('../../../src/features/analytics/read-models/tecnologiaKpi.settings');

const API = path.join(__dirname, '..', '..', '..');
const OWNER = 'Tecnologia (papel ti-gestor)';
const EXPECT = {
  // DI-BI-3: recálculo a cada 5 minutos pelo job próprio de Tecnologia (a v1 pedia 1 minuto, que nenhum job cumpria); empresa nova já nasce com a definição vigente
  'tec.availability': { model: 'rm_tech_availability', unit: 'PERCENT', critical: false, dimensions: ['serviço', 'período'], cron: '*/5 * * * *', stale: 5 },
  'tec.queues_dlq': { model: 'rm_tech_queues', unit: 'COUNT', critical: false, dimensions: ['fila', 'tipo de evento'], cron: '*/5 * * * *', stale: 5 },
  'tec.integration_errors': { model: 'rm_tech_integrations', unit: 'PERCENT', critical: true, dimensions: ['provider', 'conexão', 'família', 'ambiente'], cron: '*/5 * * * *', stale: 5 },
  'tec.freshness': { model: 'rm_tech_freshness', unit: 'COUNT', critical: false, dimensions: ['read model'], cron: '*/5 * * * *', stale: 5 },
  'tec.auth_failures': { model: 'rm_tech_auth_failures', unit: 'COUNT', critical: false, dimensions: ['tipo', 'provider'], mode: 'EVENT', stale: 15 },
  'tec.blocked_events': { model: 'rm_tech_blocked_events', unit: 'COUNT', critical: false, dimensions: ['motivo', 'tipo de evento'], mode: 'EVENT', stale: 15 },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.tec.freshness', 'Controladoria (papel controller)');
  await kit.seedSources(env, env.cX);
  await kit.hourlyProbes(env);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d680 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, e.unit, code, e.model, 'TECH_AI', 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'tec.freshness' ? 'Controladoria (papel controller)' : OWNER, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.cron || null, d.refresh_policy.maxStalenessMinutes], [e.mode || 'SCHEDULE', e.cron || null, e.stale]);
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, e.critical ? 'CRITICAL' : 'NORMAL', 'criticidade da tabela M9-D712');
    assert.equal(d.drilldown_enabled, e.critical);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    assert.ok(registry.getSourceSpec(code), 'origem registrada');
  });
}

test('m9d680 os parâmetros existem no SETTINGS_SCHEMA com o padrão do livro, rejeitam valor inválido e todos são lidos pelo código', () => {
  for (const key of Object.values(KEYS)) assert.ok(SETTINGS_SCHEMA[key] && TECH_KPI_DEFAULTS[key] !== undefined, key);
  assert.deepEqual([TECH_KPI_DEFAULTS[KEYS.windowMinutes], TECH_KPI_DEFAULTS[KEYS.authPerHour], TECH_KPI_DEFAULTS[KEYS.missingProbesMaxPct], TECH_KPI_DEFAULTS[KEYS.queueStaleMinutes]], [60, 20, 5, 15]);
  for (const bad of ['', 'consent', 'A,,B']) assert.throws(() => SETTINGS_SCHEMA[KEYS.knownBlockReasons].validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  const text = ['read-models/tecnologiaKpi.settings.js', 'metrics/kpis/tecnologia/inputs.js', 'metrics/kpis/tecnologia/rows.js', 'metrics/kpis/tecnologia/set.js']
    .map((f) => fs.readFileSync(path.join(API, 'src/features/analytics', f), 'utf8')).join('\n');
  for (const name of ['windowMinutes', 'authPerHour', 'missingProbesMaxPct', 'queueStaleMinutes', 'knownBlockReasons']) {
    assert.match(text.replace(/\/\*[\s\S]*?\*\//g, ''), new RegExp(`\\b${name}\\b[\\s\\S]*\\b${name}\\b`), `${name} é lido além de declarado`);
  }
  const used = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/kpis/tecnologia/inputs.js'), 'utf8');
  for (const field of ['probeIntervalS', 'missingProbesMaxPct', 'queueStaleMinutes', 'authPerHour', 'knownBlockReasons']) assert.ok(used.includes(`s.${field}`), `a fórmula recebe ${field} do parâmetro`);
});

test('m9d680 a semente do registry publica a versão 1 dos seis KPIs com o catálogo REAL de fórmulas', async () => {
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

test('m9d680 tec.integration_errors (CRITICAL) tem especificação de origem (registerSourceSpec) e detalhe (registerDrilldownDetail)', () => {
  const spec = registry.getSourceSpec('tec.integration_errors');
  assert.equal(spec.table, 'integration.provider_health');
  assert.equal(registry.reconcileModeForUnit('PERCENT'), 'RECOMPUTE');
  assert.equal(spec.formulaId, 'tec.integration_errors');
  const { detailOf } = require('../../../src/features/analytics/metrics/drilldown.details');
  assert.ok(detailOf(spec).columns.includes('calls_failed'));
  for (const code of Object.keys(EXPECT)) assert.ok(detailOf(registry.getSourceSpec(code)).columns.length >= 1, `${code} tem detalhe`);
});

test('m9d680 nenhum KPI desta demanda é calculado no Front, as fórmulas são puras e o Front tem o grupo de parâmetros', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['techAvailability.js', 'techQueuesDlq.js', 'techIntegrationErrors.js', 'techFreshness.js', 'techAuthFailures.js', 'techBlockedEvents.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const front = path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes');
  const group = fs.readFileSync(path.join(front, 'biTecnologiaKpiGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), ...Object.values(KEYS), 'analytics.tec.historico_dias', 'analytics.tec.sondas', 'analytics.tec.intervalo_sonda_s', 'analytics.tec.sinais_retencao_dias', 'analytics.tec.recalculo_min']) assert.ok(group.includes(key), key);
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});
