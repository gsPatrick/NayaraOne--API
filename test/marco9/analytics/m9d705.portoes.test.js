'use strict';

// M9-D705 — os portões que reprovam a promoção: etapa 3 (tabela sem RLS), 4 (fórmula sem teste ou com teste vazio), 8 (read model sem checks) e
// 14 (métrica sem aceite em produção), mais o fluxo do CI (Front ao lado da API, guardas 1 e 5 sem pular, typecheck do Front).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { avaliarTabelas, lerTabelasAnalytics } = require('../../../scripts/analytics/ci/gates/migracoes');
const { avaliarTestesDeFormula } = require('../../../scripts/analytics/ci/gates/formulas');
const { avaliarChecksPorReadModel } = require('../../../scripts/analytics/ci/gates/qualidade');
const { avaliarAceite } = require('../../../scripts/analytics/ci/gates/aceite');
const { verificarSintaxe } = require('../../../scripts/analytics/ci/gates/sintaxeFront');
const readModels = require('../../../src/features/analytics/read-models');
const quality = require('../../../src/features/analytics/quality');
const { sequelize } = require('../../testHelpers');

const ROOT = path.join(__dirname, '..', '..', '..');
after(async () => { await sequelize.close(); });

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d705p-'));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}

test('m9d705 etapa 3 reprova tabela sem RLS', async () => {
  const boa = { tabela: 'analytics.x', rls: true, forcado: true, grantRuntime: true };
  assert.deepEqual(avaliarTabelas([boa]), { ok: true, problemas: [] });
  const semForce = avaliarTabelas([boa, { tabela: 'analytics.sem_force', rls: true, forcado: false, grantRuntime: true }]);
  assert.equal(semForce.ok, false);
  assert.match(semForce.problemas[0], /analytics\.sem_force.*FORCE/);
  assert.match(avaliarTabelas([{ ...boa, tabela: 'analytics.sem_rls', rls: false, forcado: false }]).problemas[0], /analytics\.sem_rls.*RLS/);
  assert.match(avaliarTabelas([{ ...boa, tabela: 'analytics.sem_grant', grantRuntime: false }]).problemas[0], /analytics\.sem_grant.*nayara_runtime/);
  // o catálogo real do banco de teste passa
  // tabelas-fixture que testes de outras demandas criam e derrubam (rm_m9dNNN_<sufixo>) podem sobrar se o processo deles for interrompido
  const reais = (await lerTabelasAnalytics((sql) => sequelize.query(sql, { type: 'SELECT' }))).filter((t) => !/^analytics\.rm_m9d\d{3}_\d+$/.test(t.tabela));
  assert.ok(reais.length >= 20, `tabelas analytics lidas: ${reais.length}`);
  const r = avaliarTabelas(reais);
  assert.deepEqual(r.problemas, [], r.problemas.join("; "));
});

test('m9d705 etapa 4 reprova fórmula sem teste', () => {
  const helper = "const { runFormulaTable } = require('../formulaTable');\nrunFormulaTable({ id: 'a.b' }, []);\n";
  const formulas = (extra = {}) => tree({ 'formulas/a.js': 'x', 'formulas/b.js': 'x', 'tests/a.formula.test.js': helper, 'tests/b.formula.test.js': helper, ...extra });
  const ok = formulas();
  assert.deepEqual(avaliarTestesDeFormula({ formulasDir: path.join(ok, 'formulas'), testsDir: path.join(ok, 'tests'), isFormulaFile: () => true }).problemas, []);
  const sem = formulas({ 'formulas/c.js': 'x' });
  const rSem = avaliarTestesDeFormula({ formulasDir: path.join(sem, 'formulas'), testsDir: path.join(sem, 'tests'), isFormulaFile: () => true });
  assert.equal(rSem.ok, false);
  assert.match(rSem.problemas.join('\n'), /c\.js.*sem teste/);
  const vazio = formulas({ 'tests/b.formula.test.js': '' });
  assert.match(avaliarTestesDeFormula({ formulasDir: path.join(vazio, 'formulas'), testsDir: path.join(vazio, 'tests'), isFormulaFile: () => true }).problemas.join('\n'), /b\.formula\.test\.js.*vazio/);
  const semHelper = formulas({ 'tests/b.formula.test.js': "const { test } = require('node:test');\ntest('x', () => {});\n" });
  assert.match(avaliarTestesDeFormula({ formulasDir: path.join(semHelper, 'formulas'), testsDir: path.join(semHelper, 'tests'), isFormulaFile: () => true }).problemas.join('\n'), /b\.formula\.test\.js.*formulaTable/);
  const real = avaliarTestesDeFormula();
  assert.deepEqual(real.problemas, [], 'as fórmulas reais têm teste de tabela com o ajudante');
});

test('m9d705 etapa 8 reprova read model sem checks', () => {
  const real = avaliarChecksPorReadModel(readModels.listReadModels(), quality);
  assert.deepEqual(real.problemas, []);
  const fake = { name: 'rm_sem_checks_m9d705', keyColumns: ['x'] };
  const r = avaliarChecksPorReadModel([...readModels.listReadModels(), fake], quality);
  assert.equal(r.ok, false);
  assert.match(r.problemas.join('\n'), /rm_sem_checks_m9d705/);
});

test('m9d705 etapa 14 reprova métrica sem aceite quando ambiente é produção', () => {
  const metricas = [{ code: 'fin.free_cash', version: 2 }, { code: 'fin.payables_7d', version: 1 }];
  const aceites = [{ code: 'fin.free_cash', version: 2, status: 'ACCEPTED' }, { code: 'fin.payables_7d', version: 1, status: 'PENDING' }];
  const prod = avaliarAceite({ ambiente: 'PRODUCAO', metricas, aceites });
  assert.equal(prod.ok, false);
  assert.match(prod.problemas.join('\n'), /fin\.payables_7d.*sem aceite/);
  assert.equal(avaliarAceite({ ambiente: 'PRODUCAO', metricas, aceites: aceites.map((a) => ({ ...a, status: 'ACCEPTED' })) }).ok, true);
  assert.match(avaliarAceite({ ambiente: 'PRODUCAO', metricas, aceites: [{ code: 'fin.free_cash', version: 1, status: 'ACCEPTED' }] }).problemas.join('\n'), /fin\.free_cash.*versão 2/, 'aceite de versão antiga não vale');
  const lab = avaliarAceite({ ambiente: 'LAB', metricas, aceites: [] });
  assert.equal(lab.ok, true, 'em LAB a etapa só informa');
  assert.equal(lab.pendentes.length, 2);
  assert.throws(() => avaliarAceite({ ambiente: 'QUALQUER', metricas, aceites }), /ambiente/);
});

test('m9d705 etapa 2 reprova erro de sintaxe no Front de BI e passa no Front real', () => {
  const ruim = tree({ 'app/painel/analytics/Card.js': 'export default function C() { return <b>{x</b>; }\n' });
  const r = verificarSintaxe({ frontRoot: ruim });
  assert.equal(r.ok, false);
  assert.match(r.problemas[0], /Card\.js/);
  const bom = tree({ 'app/painel/analytics/Card.js': 'export default function C({ v }) { return <b>{v}</b>; }\n' });
  assert.equal(verificarSintaxe({ frontRoot: bom }).ok, true);
});

test('m9d705 o workflow faz checkout do Front, roda as guardas 1 e 5 e o pipeline do BI, sem pular', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(wf, /NayaraOne--FRONT/, 'checkout do repositório do Front ao lado da API');
  assert.match(wf, /checkFrontNoKpiMath\.js/);
  assert.match(wf, /scripts\/analytics\/ci\/run\.js --fase pr/);
  assert.match(wf, /scripts\/analytics\/ci\/run\.js --fase promocao/);
  const est = fs.readFileSync(path.join(__dirname, 'm9d614.estaticos.test.js'), 'utf8');
  assert.doesNotMatch(est, /skip:\s*!HAS_FRONT\s*&&\s*'/, 'regra 1 e regra 5 do Front não podem ficar puladas no CI');
  assert.match(est, /process\.env\.CI/);
});
