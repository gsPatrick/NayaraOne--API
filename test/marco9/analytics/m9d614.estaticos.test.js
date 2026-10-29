'use strict';

// M9-D614 — guardas estáticos do "Não improvisar" (regras 1, 2, 3, 5 e 6): passam no código real e reprovam a violação (fixtures em pasta temporária).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guards = require('../../../scripts/analytics/guardrails');
const { FRONT_ROOT } = require('../../../scripts/analytics/guardrails/files');
const { INITIAL_DEFINITIONS } = require('../../../src/features/ai/tools/definitions');

const HAS_FRONT = fs.existsSync(path.join(FRONT_ROOT, 'app'));
const API_ROOT = path.join(__dirname, '..', '..', '..');

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d614-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const rulesOf = (res) => [...new Set(res.violations.map((v) => v.rule))];

test('m9d614 regra1 front não calcula KPI (varredura estática)', { skip: !HAS_FRONT && 'repositório do Front ausente' }, () => {
  const real = guards.checkRule1(FRONT_ROOT);
  assert.deepEqual(real.violations, [], real.violations.map(guards.formatViolation).join('\n'));
  const root = tmpTree({
    'app/painel/analytics/FinanceCard.js': 'export default function C({ a, b }) {\n  const total = a.metric + b.metric;\n  const r = Math.round(a.kpi);\n  return <b>{total}{r}</b>;\n}\n',
    'app/painel/analytics/Importa.js': 'import { compute } from "@/lib/formulas/freeCash";\n',
    'app/painel/analytics/Formata.js': 'export const f = (v) => new Intl.NumberFormat("pt-BR").format(v);\n',
  });
  const bad = guards.checkRule1(root);
  assert.deepEqual(rulesOf(bad), [1]);
  assert.ok(bad.violations.some((v) => /FinanceCard/.test(v.file) && v.line === 2), 'soma de dois campos de métrica');
  assert.ok(bad.violations.some((v) => /Math\.round/.test(v.message)), 'Math.round sobre KPI');
  assert.ok(bad.violations.some((v) => /Importa/.test(v.file)), 'import de fórmula');
  assert.ok(!bad.violations.some((v) => /Formata/.test(v.file)), 'só formatar é livre');
});

test('m9d614 regra2 GET de dashboard toca só schema analytics', () => {
  const real = guards.checkRule2(API_ROOT);
  assert.deepEqual(real.violations, []);
  assert.ok(real.scanned > 0, 'o guarda enxerga o código dos painéis');
  const root = tmpTree({
    'src/features/analytics/dashboards/dashboard.service.js': "const fin = require('../../finance/finance.service');\nconst q = 'SELECT * FROM finance.financial_entries JOIN analytics.metric_snapshots s ON 1=1';\n",
    'src/features/analytics/dashboardReadStore.service.js': "const { FinancialEntry } = require('../../models');\nFinancialEntry.findAll({});\n",
  });
  const bad = guards.checkRule2(root);
  assert.deepEqual(rulesOf(bad), [2]);
  assert.equal(bad.violations.length, 3, 'feature de domínio, tabela de outro schema e modelo do OLTP');
  const ok = guards.checkRule2(tmpTree({ 'src/features/analytics/dashboards/ok.js': "const q = 'SELECT 1 FROM analytics.dashboard_widgets';\n" }));
  assert.deepEqual(ok.violations, []);
});

test('m9d614 regra3 free_cash só lê linhas próprias', () => {
  assert.deepEqual(guards.checkRule3(API_ROOT).violations, []);
  const bad = guards.checkRule3(API_ROOT, tmpTree({
    'freeCash.js': "module.exports = { id: 'fin.free_cash', version: 1, compute: (rows) => rows.reduce((a, r) => a + r.amount, 0) };\n",
    'outraCoisa.js': "module.exports = { id: 'fin.outra', version: 1, compute: () => 0 };\n",
  }));
  assert.deepEqual(bad.violations.map((v) => [v.rule, path.basename(v.file)]), [[3, 'freeCash.js']]);
  const ok = guards.checkRule3(API_ROOT, tmpTree({
    'freeCash.js': "module.exports = { id: 'fin.free_cash', version: 1, compute: (rows) => rows.filter((r) => r.is_third_party_funds === false).length };\n",
    'caixa.js': "module.exports = { id: 'fin.caixa_livre_v2', version: 1, compute: (rows) => rows.filter((r) => !r.is_third_party_funds).length };\n",
  }));
  assert.deepEqual(ok.violations, []);
});

test('m9d614 regra5 resposta sem freshness reprova', { skip: !HAS_FRONT && 'repositório do Front ausente' }, () => {
  const real = guards.checkRule5(API_ROOT, FRONT_ROOT);
  assert.deepEqual(real.violations, [], real.violations.map(guards.formatViolation).join('\n'));
  const root = tmpTree({ 'src/features/analytics/metrics/resposta.js': "module.exports = (s) => ({ metricCode: s.code, value: s.v, valueNature: s.n, asOfDate: s.d });\n" });
  const front = tmpTree({
    'app/painel/analytics/SemFrescorCard.js': 'export default function Card({ value }) { return <b>{value}</b>; }\n',
    'app/painel/analytics/ComFrescorCard.js': 'export default function Card({ value, freshness }) {\n  if (!freshness) throw new Error("freshness ausente");\n  return <b>{value}</b>;\n}\n',
  });
  const bad = guards.checkRule5(root, front);
  assert.deepEqual(bad.violations.map((v) => path.basename(v.file)).sort(), ['SemFrescorCard.js', 'resposta.js']);
  const okRoot = tmpTree({ 'src/features/analytics/metrics/resposta.js': "module.exports = (s) => ({ metricCode: s.code, value: s.v, valueNature: s.n, freshness: s.f });\n" });
  assert.deepEqual(guards.checkRule5(okRoot, null).violations, []);
});

test('m9d614 regra6 ferramenta NAY com texto livre reprova', () => {
  assert.deepEqual(guards.checkRule6(INITIAL_DEFINITIONS).violations, []);
  const tool = (extra) => ({ name: 'analytics.getMetric', category: 'READ', riskLevel: 'LOW', requiresHumanApproval: false, permissionCode: 'analytics:read', inputSchema: { type: 'object', properties: {} }, ...extra });
  const free = (props) => tool({ inputSchema: { type: 'object', properties: props } });
  assert.equal(guards.checkRule6([free({ metricCode: { type: 'string', enum: ['fin.free_cash'] } })]).violations.length, 0, 'lista fechada é permitida');
  assert.equal(guards.checkRule6([free({ sql: { type: 'string' } })]).violations.length, 1, 'SQL em texto livre');
  assert.equal(guards.checkRule6([free({ whereClause: { type: 'string' } })]).violations.length, 1);
  assert.equal(guards.checkRule6([free({ query: { type: 'string' } })]).violations.length, 1, 'consulta livre em ferramenta de BI');
  assert.equal(guards.checkRule6([free({ filtro: { type: 'string', description: 'Trecho de SQL aplicado à consulta' } })]).violations.length, 1, 'descrito como SQL');
  assert.equal(guards.checkRule6([tool({ category: 'WRITE', riskLevel: 'HIGH', requiresHumanApproval: true })]).violations.length, 2, 'BI só lê read model');
  assert.equal(guards.checkRule6([tool({ permissionCode: 'finance:read' })]).violations.length, 1, 'BI exige permissão analytics');
  const search = { name: 'knowledge.search', category: 'READ', riskLevel: 'LOW', permissionCode: 'ia:read', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } };
  assert.deepEqual(guards.checkRule6([search]).violations, [], 'busca textual de conhecimento não é consulta ao banco');
});

test('m9d614 os guardas não têm flag para desligar e o pipeline os executa', () => {
  const dir = path.join(API_ROOT, 'scripts', 'analytics');
  const files = [...fs.readdirSync(path.join(dir, 'guardrails')).map((f) => path.join(dir, 'guardrails', f)), path.join(dir, 'checkGuardrails.js'), path.join(dir, 'checkFrontNoKpiMath.js')];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(text, /process\.env|process\.argv|\bskip\b|\bdisable/i, `${path.basename(f)} não pode ter modo de desligar`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['guard:analytics-rules'], 'node scripts/analytics/checkGuardrails.js');
  assert.match(pkg.scripts.test, /test\/marco9\/\*\*\/\*\.test\.js/, 'npm test inclui o teste dos guardas com banco (regras 4 e 7)');
  assert.deepEqual(Object.keys(guards.RULE_TITLES), ['1', '2', '3', '4', '5', '6', '7']);
});
