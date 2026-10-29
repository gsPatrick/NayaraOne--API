'use strict';

// M9-D710 — registro das três métricas (versão 1, fórmula, fonte, dimensões, unidade, owner, refresh, qualidade, CRITICAL com drill-down), tabela rm_command_events (colunas, RLS FORCE, UNIQUE),
// parâmetros do administrador (janela, valor relevante, owners), semente do registry, origem e regras estáticas (Front sem cálculo, fórmulas puras, tamanho de arquivo). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kit = require('../_helpers/m9d710Env');
const registry = require('../../../src/features/analytics/metrics');
const seed = require('../../../src/features/analytics/metrics/seed');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const cfg = require('../../../src/features/analytics/read-models/commandEvents.settings');

const API = path.join(__dirname, '..', '..', '..');
const EVENT = { mode: 'EVENT', maxStalenessMinutes: 15 };
const EXPECT = {
  'legal.contracts_signed': { domain: 'LEGAL', dimensions: ['empresa', 'tipo de contrato'], owner: 'Jurídico (papel juridico-gestor)' },
  'crm.opportunities_won': { domain: 'CRM', dimensions: ['empresa', 'corretor', 'origem'], owner: 'Gerência Comercial (papel comercial-gestor)' },
  'fin.payments_settled_relevant': { domain: 'FINANCE', dimensions: ['empresa', 'conta', 'terceiro sim/não'], owner: 'Diretoria Financeira (papel financeiro-gestor)' },
};
let env;
before(async () => {
  env = await kit.setup();
  await kit.setSetting(env, env.cX, 'analytics.owner.crm.opportunities_won', 'Controladoria (papel controller)');
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const definition = async (code) => (await env.admin.query(
  `SELECT d.owner_role, d.status, d.domain, d.criticality, d.drilldown_enabled, v.version, v.unit, v.formula_id, v.source_read_model, v.refresh_policy, v.quality_rule, v.dimensions, v.value_nature
     FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: env.cX.companyId, code } }))[0][0];

for (const [code, e] of Object.entries(EXPECT)) {
  test(`m9d710 ${code} existe no registry com versão 1, fórmula, fonte, dimensões, unidade, owner, refresh e regra de qualidade`, async () => {
    const d = await definition(code);
    assert.deepEqual([d.version, d.unit, d.formula_id, d.source_read_model, d.domain, d.status, d.value_nature], [1, 'COUNT', code, 'rm_command_events', e.domain, 'PUBLISHED', 'ACTUAL']);
    assert.deepEqual(d.dimensions, e.dimensions);
    assert.equal(d.owner_role, code === 'crm.opportunities_won' ? 'Controladoria (papel controller)' : e.owner, 'owner padrão da demanda ou o parâmetro da empresa');
    assert.deepEqual([d.refresh_policy.mode, d.refresh_policy.maxStalenessMinutes], [EVENT.mode, EVENT.maxStalenessMinutes], 'atualização por evento');
    assert.ok(d.quality_rule.referenceReport && d.quality_rule.requiredFields.length >= 1);
    assert.equal(d.criticality, 'CRITICAL', 'tabela da M9-D712');
    assert.equal(d.drilldown_enabled, true);
    assert.equal(registry.getFormulaCatalog().get(code).version, 1);
    assert.ok(SETTINGS_SCHEMA[`analytics.owner.${code}`], 'o owner é parâmetro do administrador');
    const spec = registry.getSourceSpec(code);
    assert.ok(spec && spec.table === 'analytics.rm_command_events', 'origem registrada');
  });
}

test('m9d710 a tabela rm_command_events tem as colunas da seção 3.1, RLS FORCE com 4 políticas, UNIQUE (kind, source_id, revision) e GRANT só ao runtime', async () => {
  const [cols] = await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = 'rm_command_events'");
  const names = cols.map((c) => c.column_name);
  for (const c of ['id', 'company_id', 'kind', 'source_type', 'source_id', 'revision', 'is_reversal', 'occurred_at', 'occurred_date', 'amount', 'is_third_party', 'broker_id', 'source_event_id', 'source_snapshot_at', 'refreshed_at', 'version']) {
    assert.ok(names.includes(c), `coluna ${c}`);
  }
  const [[rls]] = await env.admin.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND i.indnatts = 4) AS uniques
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_command_events'`
  );
  assert.deepEqual([rls.relrowsecurity, rls.relforcerowsecurity, rls.policies], [true, true, 4]);
  assert.ok(rls.uniques >= 1, 'chave única (empresa, kind, source_id, revision)');
  const [[grant]] = await env.admin.query("SELECT has_table_privilege('nayara_runtime', 'analytics.rm_command_events', 'SELECT,INSERT,UPDATE,DELETE') AS ok");
  assert.equal(grant.ok, true);
});

test('m9d710 os parâmetros existem no SETTINGS_SCHEMA, têm o padrão do livro e rejeitam valor inválido', () => {
  assert.deepEqual([cfg.COMMAND_DEFAULTS['analytics.centro.janela_horas'], cfg.COMMAND_DEFAULTS['analytics.centro.valor_relevante']], [24, 'R$ 10.000,00']);
  const hours = SETTINGS_SCHEMA['analytics.centro.janela_horas'];
  assert.deepEqual([hours.type, hours.min, hours.max], ['integer', 1, 720]);
  const validate = SETTINGS_SCHEMA['analytics.centro.valor_relevante'].validate;
  for (const good of ['R$ 10.000,00', '10000,00', '10000.00', 'R$ 0,50', '25000']) assert.doesNotThrow(() => validate('k', good), good);
  for (const bad of ['', 'dez mil', '-5', 'R$ 10,000.00', '10.00.00', '1e5']) assert.throws(() => validate('k', bad), (e) => e.code === 'SETTING_INVALID_VALUE', bad);
  assert.equal(cfg.parseMoneyText('R$ 10.000,00'), '10000.00');
  assert.equal(cfg.parseMoneyText('9.999,99'), '9999.99');
  assert.equal(cfg.parseMoneyText('25000'), '25000.00');
  assert.equal(cfg.parseMoneyText('0,5'), '0.50');
  assert.equal(cfg.parseMoneyText('abc'), null);
});

test('m9d710 a semente do registry publica a versão 1 dos três KPIs com o catálogo REAL de fórmulas e o read model existente', async () => {
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

test('m9d710 nenhum KPI é calculado no Front, as fórmulas são puras, o Front tem o grupo de parâmetros e nenhum arquivo passa de 400 linhas', () => {
  const guard = spawnSync('node', ['scripts/analytics/checkFrontNoKpiMath.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  for (const f of ['legalContractsSigned.js', 'crmOpportunitiesWon.js', 'finPaymentsSettledRelevant.js', '_commandKpi.js']) {
    const text = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/formulas', f), 'utf8');
    assert.doesNotMatch(text, /Math\.random|Date\.now|new Date\(\)|parseFloat|toFixed|require\('(\.\.\/)+(models|utils)/, `${f} sem relógio, sorteio, ponto flutuante nem banco`);
  }
  const group = fs.readFileSync(path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes', 'biCentroComandoFatosGroups.js'), 'utf8');
  for (const key of [...Object.keys(EXPECT).map((c) => `analytics.owner.${c}`), 'analytics.centro.janela_horas', 'analytics.centro.valor_relevante']) assert.ok(group.includes(key), key);
  const tab = fs.readFileSync(path.join(API, '..', 'NayaraOne--FRONT', 'app', 'painel', 'configuracoes', 'BiTab.js'), 'utf8');
  assert.ok(tab.includes('BI_CENTRO_COMANDO_FATOS_GROUPS'), 'o grupo está na aba BI e Centro de Comando');
  const size = spawnSync('node', ['scripts/check-file-size.js'], { cwd: API, encoding: 'utf8' });
  assert.equal(size.status, 0, size.stdout + size.stderr);
});

test('m9d710 os parâmetros são lidos de verdade: owner da empresa, janela e limiar vêm do administrador, nunca de valor fixo no código', () => {
  const set = fs.readFileSync(path.join(API, 'src/features/analytics/metrics/kpis/centro-comando/set.js'), 'utf8');
  assert.match(set, /readWindowHours/);
  assert.match(set, /readRelevantAmount/);
  assert.match(set, /readCommandOwner/);
});
