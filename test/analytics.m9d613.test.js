'use strict';

// M9-D613 — estrutura de src/features/analytics e regras de dependência entre camadas. Testes estáticos (sem banco).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');

const API_ROOT = path.join(__dirname, '..');
const BASE = path.join(API_ROOT, 'src', 'features', 'analytics');
const DEMANDAS = path.join(API_ROOT, '..', 'Maturacao', 'demandas', 'marco-9');
const CAMADAS = ['metrics', 'read-models', 'dashboards', 'alerts', 'quality', 'exports', 'briefs'];
const RULE = 'nayara/analytics-camadas';

test('m9d613 as 7 subpastas existem com index.js e README', () => {
  const dirs = fs.readdirSync(BASE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const c of CAMADAS) {
    assert.ok(dirs.includes(c), `falta a subpasta ${c}`);
    assert.ok(fs.existsSync(path.join(BASE, c, 'index.js')), `${c}/index.js`);
    const readme = fs.readFileSync(path.join(BASE, c, 'README.md'), 'utf8');
    assert.ok(/prop[óo]sito/i.test(readme) && /entradas/i.test(readme) && /sa[íi]das/i.test(readme), `${c}/README.md precisa de propósito, entradas e saídas`);
    const api = require(path.join(BASE, c));
    assert.equal(api.camada, c);
  }
});

async function lintar(file, target) {
  const eslint = new ESLint({ cwd: API_ROOT });
  const dir = path.dirname(path.join(API_ROOT, file));
  let spec = target;
  if (!target.startsWith('.') && target.startsWith('src/')) {
    spec = path.relative(dir, path.join(API_ROOT, target)).split(path.sep).join('/');
    if (!spec.startsWith('.')) spec = `./${spec}`;
  }
  const code = `'use strict';\nrequire('${spec}');\n`;
  return (await eslint.lintText(code, { filePath: path.join(API_ROOT, file) }))[0].messages.filter((m) => m.ruleId === RULE);
}

test('m9d613 lint barra fórmula com import de models', async () => {
  const f = 'src/features/analytics/metrics/formulas/x.formula.js';
  for (const t of ['src/models/index', 'src/models/Property', 'src/utils/AppError', 'src/features/analytics/dashboards/index', 'sequelize', 'pg']) {
    assert.ok((await lintar(f, t)).length > 0, `deveria reprovar ${t}`);
  }
  for (const t of ['../metricPeriod', './round.formula', 'node:crypto', 'crypto']) {
    assert.equal((await lintar(f, t)).length, 0, `deveria permitir ${t}`);
  }
});

test('m9d613 lint barra dashboards lendo tabelas de origem', async () => {
  for (const f of ['src/features/analytics/dashboards/x.js', 'src/features/analytics/briefs/x.js']) {
    for (const t of ['src/models/index', 'src/models/FinancialEntry', 'src/features/finance/finance.service', 'src/features/analytics/read-models/crm.readmodel', 'sequelize']) {
      assert.ok((await lintar(f, t)).length > 0, `deveria reprovar ${t} em ${f}`);
    }
    for (const t of ['src/features/analytics/metrics/index', 'src/features/analytics/read-models/index', 'src/utils/AppError', 'src/features/analytics/dashboardStore.service']) {
      assert.equal((await lintar(f, t)).length, 0, `deveria permitir ${t} em ${f}`);
    }
  }
  // Fora de dashboards/briefs/formulas a regra não se aplica (read-models é a camada que lê a origem).
  assert.equal((await lintar('src/features/analytics/read-models/x.js', 'src/models/index')).length, 0);
});

test('m9d613 lint de dependências ativo na configuração usada pelo npm run lint', async () => {
  const pkg = require('../package.json');
  assert.match(pkg.scripts.lint, /lintRatchet/);
  const cfg = await new ESLint({ cwd: API_ROOT }).calculateConfigForFile(path.join(BASE, 'dashboards', 'x.js'));
  assert.equal(cfg.rules['nayara/analytics-camadas'][0], 2);
});

function lerDemandas() {
  const out = {};
  for (const f of fs.readdirSync(DEMANDAS)) {
    const m = /^M9-D(\d+)-/.exec(f);
    if (!m) continue;
    const st = /^\| Status \| (\S+) \|/m.exec(fs.readFileSync(path.join(DEMANDAS, f), 'utf8'));
    out[m[1]] = st ? st[1] : null;
  }
  return out;
}

const PASSOS = require('../scripts/lib/analyticsBuildOrder');

test('m9d613 ordem exata dos 11 passos respeitada pelas demandas', () => {
  assert.equal(PASSOS.length, 11);
  const dem = lerDemandas();
  for (const p of PASSOS) for (const d of p.demandas) assert.ok(d in dem, `demanda D${d} do passo ${p.passo} não existe`);
  const verificada = (d) => dem[d] === 'verificada';
  PASSOS.forEach((p, i) => {
    if (!p.demandas.some(verificada)) return;
    for (const anterior of PASSOS.slice(0, i)) {
      for (const d of anterior.demandas) {
        assert.ok(verificada(d), `passo ${p.passo} (${p.nome}) tem demanda verificada mas D${d} do passo ${anterior.passo} (${anterior.nome}) não está verificada`);
      }
    }
  });
});

test('m9d613 o verificador de ordem reprova a violação (passo 6 antes do 4)', () => {
  const { violacoes } = require('../scripts/lib/analyticsBuildOrder');
  const dem = { 603: 'verificada', 607: 'verificada', 609: 'verificada', 626: 'aberta', 634: 'aberta', 653: 'aberta', 691: 'verificada' };
  assert.ok(violacoes(dem).length > 0);
  assert.deepEqual(violacoes({ 603: 'verificada' }), []);
});

test('m9d613 documento da ordem de construção lista os 11 passos', () => {
  const doc = fs.readFileSync(path.join(API_ROOT, 'docs', 'ANALYTICS_ORDEM_CONSTRUCAO.md'), 'utf8');
  for (const p of PASSOS) {
    assert.ok(doc.includes(`${p.passo}. ${p.nome}`), `passo ${p.passo}`);
    for (const d of p.demandas) assert.ok(doc.includes(`M9-D${d}`), `D${d}`);
  }
});

test('m9d613 rotas /analytics montadas', () => {
  const { router, createAnalyticsRouter } = require('../src/features/analytics');
  assert.equal(typeof createAnalyticsRouter, 'function');
  assert.ok(router.stack.some((l) => l.regexp && l.regexp.test('/analytics/x')), 'router deve tratar /analytics');
  const index = fs.readFileSync(path.join(API_ROOT, 'src', 'routes', 'index.js'), 'utf8');
  assert.match(index, /router\.use\('\/v1', analyticsModuleRouter\)/);
  const mod = require('../src/features/analytics');
  for (const c of CAMADAS) assert.ok(mod.camadas.includes(c));
});
