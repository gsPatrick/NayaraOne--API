'use strict';

// M9-D695 (BI-010, Guia §9 e §14) — a NAY Diretoria tem um catálogo FECHADO de 7 ferramentas de leitura: nenhuma aceita consulta livre, nenhuma
// importa o cliente do banco e o registro recusa o cadastro de ferramenta com consulta livre.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env695 = require('../_helpers/m9d695Env');
const { ToolRegistry } = require('../../../src/features/ai/tools');
const { NAY_TOOL_DEFINITIONS, NAY_TOOL_NAMES } = require('../../../src/features/analytics/briefs');
const { scanSource } = require('../../../scripts/lib/analyticsReadScan');

let env;
before(async () => { env = await env695.setup(); });
after(() => env695.teardown(env));

const ROOT = path.join(__dirname, '..', '..', '..');
const BRIEFS = path.join(ROOT, 'src', 'features', 'analytics', 'briefs');
const PERMISSIONS = new Set(['analytics:read']);
const reject = (fn, status, code) => assert.throws(fn, (e) => { assert.equal(e.statusCode, status, e.message); assert.equal(e.code, code); return true; });
const tool = (inputSchema, over = {}) => ({
  name: 'analytics.runQuery', version: 1, description: 'x', permissionCode: 'analytics:read', riskLevel: 'LOW', category: 'READ', domain: 'OTHER',
  requiresHumanApproval: false, idempotent: true, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } }, execute: async () => ({ ok: true }), inputSchema, ...over,
});
const strictObj = (properties) => ({ type: 'object', properties, additionalProperties: false });

test('m9d695 NAY não consegue executar SQL livre (catálogo fechado)', async () => {
  assert.deepEqual(env.nayRegistry.list().map((t) => t.name), [...NAY_TOOL_NAMES].sort());
  assert.equal(env.nayRegistry.list().length, 7);
  assert.deepEqual([...NAY_TOOL_NAMES].sort(), ['analytics.getDashboardSummary', 'analytics.getFreshness', 'analytics.getMetric', 'analytics.getMetricBreakdown', 'analytics.getMetricVariation', 'analytics.getSourceRefs', 'analytics.listAlerts']);
  for (const def of env.nayRegistry.list()) {
    assert.deepEqual([def.category, def.riskLevel, def.requiresHumanApproval, def.idempotent, def.permissionCode], ['READ', 'LOW', false, true, 'analytics:read'], def.name);
  }
  await env695.inTx(env.tenantA, {}, async (tx) => {
    for (const name of ['analytics.runSql', 'sql.query', 'finance.getDelinquency', 'analytics.exportAll', 'crm.createFollowUpTask']) {
      const err = await env695.callTool(env, env.tenantA, tx, env695.FINANCE_USER, name, { sql: 'SELECT * FROM analytics.metric_snapshots' }).then(() => null, (e) => e);
      assert.ok(err, name);
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'ANALYTICS_AI_TOOL_NOT_ALLOWED', name);
      assert.equal(err.message, 'Ferramenta não permitida para este agente.');
    }
    // dentro do catálogo, o modelo não consegue empurrar SQL nem outro argumento: o schema é fechado
    for (const args of [{ metricCode: 'fin.caixa', period: '2026-10', sql: 'DROP TABLE x' }, { metricCode: 'fin.caixa; DROP TABLE x', period: '2026-10' }, { metricCode: 'fin.caixa', period: "2026-10' OR '1'='1" }]) {
      const err = await env695.callTool(env, env.tenantA, tx, env695.FINANCE_USER, 'analytics.getMetric', args).then(() => null, (e) => e);
      assert.ok(err && err.statusCode === 400, JSON.stringify(args));
    }
    // o agente recebe só funções de leitura: não existe cliente de banco no contexto da ferramenta
    const spy = { ...NAY_TOOL_DEFINITIONS[0], name: 'analytics.getMetric', execute: async (ctx) => ctx.sequelize.query('SELECT 1') };
    const reg = new ToolRegistry({ permissionCodes: PERMISSIONS });
    reg.register(spy);
    const err = await env695.callTool(env, env.tenantA, tx, env695.FINANCE_USER, 'analytics.getMetric', { metricCode: 'fin.caixa', period: '2026-10' }, { registry: reg }).then(() => null, (e) => e);
    assert.equal(err.code, 'AI_CAPABILITY_FORBIDDEN');
  });
});

test('m9d695 cadastro de ferramenta com parâmetro de consulta livre é recusado', () => {
  const registry = () => new ToolRegistry({ permissionCodes: PERMISSIONS });
  const code = 'ANALYTICS_AI_TOOL_FREE_QUERY_FORBIDDEN';
  reject(() => registry().register(tool(strictObj({ query: { type: 'string', maxLength: 200 } }))), 422, code);
  reject(() => registry().register(tool(strictObj({ metricCode: { type: 'string', maxLength: 80 } }))), 422, code); // texto sem enum nem padrão
  reject(() => registry().register(tool(strictObj({ sql: { type: 'string', enum: ['a', 'b'] } }))), 422, code); // nome de consulta, mesmo com enum
  reject(() => registry().register(tool(strictObj({ filter: { type: 'string', pattern: '^[a-z]+$', maxLength: 20 } }))), 422, code);
  reject(() => registry().register(tool(strictObj({ tabela: { type: 'string', enum: ['a'] } }))), 422, code);
  reject(() => registry().register(tool(strictObj({ filtros: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 5 } }))), 422, code);
  reject(() => registry().register(tool({ type: 'object', properties: { period: { type: 'string', pattern: '^20[0-9]{2}$' } }, additionalProperties: true })), 422, code);
  reject(() => registry().register(tool({ type: 'object', properties: { period: { type: 'string', pattern: '^20[0-9]{2}$' } }, patternProperties: { '.*': { type: 'string' } }, additionalProperties: false })), 422, code);
  // o esquema restrito do livro passa; ferramenta que não é do BI não é afetada por esta regra
  registry().register(tool(strictObj({ period: { type: 'string', pattern: '^20[0-9]{2}$', maxLength: 4 }, status: { type: 'string', enum: ['OPEN'] }, id: { type: 'string', format: 'uuid' } })));
  registry().register(tool(strictObj({ query: { type: 'string', maxLength: 200 } }), { name: 'knowledge.searchTexto', permissionCode: 'analytics:read' }));
  for (const def of NAY_TOOL_DEFINITIONS) assert.doesNotThrow(() => registry().register(def), def.name);
});

test('m9d695 contrato do catálogo: nenhum parâmetro de texto livre e nada de consulta', () => {
  const stringsOf = (schema, p = '') => {
    if (!schema || typeof schema !== 'object') return [];
    const own = [].concat(schema.type).includes('string') ? [{ path: p, schema }] : [];
    const kids = Object.entries(schema.properties || {}).flatMap(([n, s]) => stringsOf(s, `${p}.${n}`));
    return [...own, ...kids, ...(schema.items ? stringsOf(schema.items, `${p}[]`) : [])];
  };
  assert.equal(NAY_TOOL_DEFINITIONS.length, 7);
  for (const def of NAY_TOOL_DEFINITIONS) {
    assert.equal(def.inputSchema.additionalProperties, false, def.name);
    assert.ok(!('companyId' in def.inputSchema.properties) && !('groupId' in def.inputSchema.properties) && !('userId' in def.inputSchema.properties), `${def.name}: a empresa vem do servidor`);
    for (const { path: p, schema } of stringsOf(def.inputSchema)) {
      assert.ok(Array.isArray(schema.enum) || typeof schema.pattern === 'string' || schema.format === 'uuid', `${def.name}${p}: texto precisa de enum ou padrão de códigos conhecidos`);
    }
    assert.doesNotMatch(Object.keys(def.inputSchema.properties).join(' '), /(?:^|\s)(?:sql|query|expression|filter|table|where|script|code)(?:\s|$)/i, def.name);
  }
});

test('m9d695 ferramentas não importam cliente de banco', () => {
  const files = fs.readdirSync(BRIEFS).filter((f) => /^nayTools.*\.js$/.test(f)).map((f) => path.join(BRIEFS, f));
  files.push(path.join(ROOT, 'src', 'features', 'ai', 'toolServices', 'analytics.services.js'), path.join(ROOT, 'src', 'features', 'ai', 'tools', 'nayDiretoriaRegistry.js'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const requires = [...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const spec of requires) {
      assert.doesNotMatch(spec, /(^|\/)models(\/|$)|^sequelize$|^pg(-hstore)?$|^knex$|database|\/db$/i, `${path.basename(file)} importa ${spec}`);
    }
    assert.doesNotMatch(text, /\b(sequelize\.query|queryInterface|\.raw\(|SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)/i, `${path.basename(file)}: nenhum SQL`);
    assert.deepEqual(scanSource(path.relative(ROOT, file), fs.readFileSync(file, 'utf8')), [], `${path.basename(file)}: varredura de segurança do BI (R1 a R3)`);
  }
});
