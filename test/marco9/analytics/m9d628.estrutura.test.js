'use strict';

// M9-D628 — estrutura dos read models de Tecnologia e IA: colunas do livro, RLS FORCE, nenhum dado pessoal, eventos conferidos nos catálogos de origem, parâmetros no
// SETTINGS_SCHEMA e catálogo de checks de qualidade em cada um. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env628 = require('../_helpers/m9d628Env');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const events = require('../../../src/features/analytics/read-models/tecnologia/events');
const { TECH_DEFAULTS, KEYS } = require('../../../src/features/analytics/read-models/tecnologia.settings');
const quality = require('../../../src/features/analytics/quality/quality.catalog');

let env;
before(async () => { env = await env628.setup(); });
after(() => env628.teardown(env));

const COMMON = ['company_id', 'group_id', 'source_snapshot_at', 'refreshed_at', 'version'];
const LIVRO = {
  rm_tech_availability: ['probe', 'day', 'checks', 'up'],
  rm_tech_queues: ['queue', 'event_type', 'depth', 'dlq_depth'],
  rm_tech_integrations: ['provider', 'family', 'environment', 'window_minutes', 'calls', 'errors', 'success_rate', 'latency_p95_ms', 'latency_p99_ms', 'rate_limit_count', 'auth_failures', 'retries', 'dlq', 'backlog', 'quota_remaining'],
  rm_tech_freshness: ['read_model', 'max_age_minutes', 'state'],
  rm_tech_blocked_events: ['day', 'blocked', 'reason'],
  rm_tech_auth_failures: ['day', 'kind', 'provider', 'failures'],
  rm_ai_cost: ['agent', 'month', 'cost_brl', 'budget_brl'],
  rm_ai_quality: ['agent', 'week', 'grounding_score_sum', 'eval_score_sum', 'runs'],
  rm_ai_tool_calls: ['agent', 'day', 'calls', 'blocked'],
};
const columnsOf = async (table) => (await env.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND table_name = :t", { replacements: { t: table } }))[0].map((r) => r.column_name);

test('m9d628 o read model existe com as colunas descritas e RLS FORCE', async () => {
  assert.deepEqual(Object.keys(LIVRO).sort(), [...env628.MODELS].sort());
  for (const model of env628.MODELS) {
    const have = await columnsOf(model);
    for (const c of [...LIVRO[model], ...COMMON]) assert.ok(have.includes(c), `${model}: falta a coluna ${c}`);
    const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      has_table_privilege('nayara_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS runtime_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = :model`, { replacements: { model } });
    assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies, r.runtime_grant], [true, true, 4, true], model);
    const def = env628.readModels.getReadModel(model);
    assert.ok(def, `${model} está registrado`);
    assert.deepEqual(await env628.readModels.assertReadModelTable(def, null), [], `${model}: colunas comuns e índice único da chave`);
    assert.equal(typeof def.rebuild.keys, 'function', `${model} declara rebuild.keys`);
  }
});

test('m9d628 o registro de sinais técnicos é global, com RLS FORCE e só o escritor do BI lê e grava', async () => {
  const have = await columnsOf('tech_signal_log');
  assert.ok(!have.includes('company_id'), 'o sinal é do sistema, não de uma empresa');
  const [[r]] = await env.admin.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT array_agg(p.polcmd::text ORDER BY p.polcmd::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS cmds,
    has_table_privilege('nayara_runtime', c.oid, 'SELECT,INSERT,DELETE') AS runtime_grant
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'tech_signal_log'`);
  assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.cmds, r.runtime_grant], [true, true, ['a', 'd', 'r'], true], 'sem política de UPDATE: o sinal é imutável');
  await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: env628.NOW });
  const visible = await env628.inTx(env.tenantA, {}, async (tx) => (await env628.sequelize.query('SELECT count(*)::int AS n FROM analytics.tech_signal_log', { transaction: tx }))[0][0].n);
  assert.equal(visible, 0, 'uma requisição de empresa (sem o escritor do BI) não enxerga nenhum sinal');
  const written = await env628.inTx(env.tenantA, {}, async (tx) => {
    await env628.sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction: tx });
    return (await env628.sequelize.query('SELECT count(*)::int AS n FROM analytics.tech_signal_log', { transaction: tx }))[0][0].n;
  });
  assert.ok(written >= 1, 'o escritor do BI enxerga');
  await assert.rejects(env628.inTx(env.tenantA, {}, (tx) => env628.sequelize.query("INSERT INTO analytics.tech_signal_log (kind, probe, ok) VALUES ('PROBE', 'API', true)", { transaction: tx })), /row-level security/);
});

test('m9d628 nenhum dado pessoal restrito é copiado para o read model', async () => {
  const pii = /(^|_)(nome|name|document|cpf|cnpj|email|phone|telefone|person|pessoa|user|owner|party|parte|ip_address|prompt|response|resposta|content|conteudo|password|token|secret|address)(_|$)/i;
  for (const model of [...env628.MODELS, 'tech_signal_log']) for (const c of await columnsOf(model)) assert.doesNotMatch(c, pii, `${model}.${c}`);
  const dir = path.join(__dirname, '../../../src/features/analytics/read-models/tecnologia');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(sources.length >= 10);
  for (const file of sources) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\b(cpf|cnpj|email|phone|full_name|person_id|prompt|input_summary|output_summary|payload_snapshot|sanitized_payload|message|args_sanitized|secret_ref)\b/i, file);
  }
});

test('m9d628 eventos conferem com os catálogos de origem e os parâmetros estão no SETTINGS_SCHEMA e são lidos', () => {
  const root = path.join(__dirname, '../../../src/features');
  const text = ['integrations/dispatch/dispatch.events.js', 'integrations/registry/providers.service.js', 'ai/events/aiEvents.catalog.js', 'ai/tools/toolCalls.constants.js',
    'ai/evaluations/evaluations.constants.js', 'marketing/marketing.events.catalog.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const all = new Set(Object.values(events).flat());
  assert.ok(all.size >= 9);
  assert.deepEqual([...all].filter((name) => !text.includes(`'${name}'`)), [], 'todo evento citado existe no catálogo de origem');
  for (const key of Object.values(KEYS)) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} está no SETTINGS_SCHEMA`);
    assert.notEqual(TECH_DEFAULTS[key], undefined, `${key} tem padrão`);
  }
  assert.throws(() => SETTINGS_SCHEMA[KEYS.probes].validate(KEYS.probes, 'api,db'), /lista de códigos/);
  const readers = fs.readdirSync(path.join(root, 'analytics/read-models/tecnologia')).map((f) => fs.readFileSync(path.join(root, 'analytics/read-models/tecnologia', f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(root, '../engines/jobs/analyticsTechProbeJob.js'), 'utf8');
  for (const name of ['historyDays', 'probeIntervalS', 'probes', 'signalRetentionDays']) assert.match(readers, new RegExp(`\\b${name}\\b`), `${name} é lido por algum consumidor`);
});

test('m9d628 cada read model declara o catálogo mínimo de checks de qualidade (M9-D696)', () => {
  require('../../../src/features/analytics');
  for (const model of env628.MODELS) {
    const types = new Set(quality.getChecks(model).map((c) => c.type));
    for (const t of ['FRESHNESS', 'RECONCILIATION', 'INVARIANT', 'COMPLETENESS', 'DUPLICATION', 'ROW_COUNT_RANGE']) assert.ok(types.has(t), `${model}: falta ${t}`);
  }
});
