'use strict';

// M9-D605 — fórmulas determinísticas, aritmética decimal e arredondamento financeiro consistente. Roda em banco descartável
// (o determinismo do registro carrega os models): node scripts/withDisposableDb.js ... (ver m9d603.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ESLint } = require('eslint');
const money = require('../src/modules/analytics/metrics/formulas/money');
const { calcHash } = require('../src/modules/analytics/metrics/calcHash');
const { findFormulasWithoutTests } = require('../scripts/analytics/checkFormulaTests');
const { assertDeterministicFormula } = require('../src/modules/analytics/metrics/formulaDeterminism');
const { runFormulaTable } = require('./analytics/formulaTable');

const API_ROOT = path.join(__dirname, '..');
const FORMULAS_DIR = path.join(API_ROOT, 'src', 'modules', 'analytics', 'metrics', 'formulas');

const ROUNDING_TABLE = [
  ['0.005', '0.01'], ['-0.005', '-0.01'], ['0.004', '0.00'], ['-0.004', '0.00'], ['0.125', '0.13'], ['-0.125', '-0.13'],
  ['1.005', '1.01'], ['2.675', '2.68'], ['-2.675', '-2.68'], ['0.994', '0.99'], ['0.995', '1.00'], ['999.995', '1000.00'],
  ['1.5', '1.50'], ['0', '0.00'], ['100', '100.00'], ['12345678901234567890.125', '12345678901234567890.13'],
  ['-0.015', '-0.02'], ['0.014999', '0.01'], ['7.1', '7.10'], ['1e', null],
];

test('m9d605 arredondamento financeiro consistente (tabela de 20 casos, positivos, negativos, half-up)', () => {
  assert.equal(ROUNDING_TABLE.length, 20);
  for (const [input, expected] of ROUNDING_TABLE) {
    if (expected === null) {
      assert.throws(() => money.money(input), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_FORMULA_INPUT_INVALID');
    } else {
      assert.equal(money.money(input), expected, `${input} -> ${expected}`);
    }
  }
  assert.equal(money.money(money.sum(['0.335', '0.335', '0.335'])), '1.01', 'três de 0,335 somam 1,005 e arredondam uma vez só: 1,01');
});

test('m9d605 soma de 1000 valores de 0,01 dá 10,00 exato', () => {
  const values = Array.from({ length: 1000 }, () => '0.01');
  assert.equal(money.money(money.sum(values)), '10.00');
  assert.equal(money.toString(money.sum(values)), '10.00');
  assert.equal(money.money(money.sum(['0.1', '0.2'])), '0.30');
});

test('m9d605 determinismo: 1000 execuções, mesmo hash', () => {
  const formula = {
    id: 'fin.m9d605_total', version: 1,
    compute: (rows) => ({ value: money.money(money.sum(rows.map((r) => r.v))) }),
  };
  const rows = [{ v: '10.005' }, { v: '20.004' }, { v: '30.005' }];
  const hashes = new Set();
  const values = new Set();
  for (let i = 0; i < 1000; i += 1) {
    values.add(formula.compute(rows).value);
    hashes.add(calcHash({ metricCode: 'fin.m9d605_total', version: 1, inputs: rows, params: {} }));
  }
  assert.deepEqual([...values], ['60.01']);
  assert.equal(hashes.size, 1);
  assert.notEqual(calcHash({ metricCode: 'fin.m9d605_total', version: 2, inputs: rows, params: {} }), [...hashes][0], 'a versão entra no hash');
  assert.notEqual(calcHash({ metricCode: 'fin.m9d605_total', version: 1, inputs: rows, params: { h: 7 } }), [...hashes][0], 'os parâmetros entram no hash');
});

test('m9d605 lint proíbe Date.now, Math.random e Number em dinheiro', async () => {
  const eslint = new ESLint({ cwd: API_ROOT });
  const file = path.join(FORMULAS_DIR, 'x.js');
  const RULE = 'nayara/no-float-money';
  const lint = async (code) => (await eslint.lintText(`'use strict';\n${code}\n`, { filePath: file }))[0].messages.filter((m) => m.ruleId === RULE);
  const ruins = [
    'const a = Date.now();', 'const a = Math.random();', 'const a = Number(x);', 'const a = parseFloat(x);', 'const a = x.toFixed(2);',
    'const a = new Date();', 'const a = Math.round(x * 100) / 100;', 'const a = 0.1;', 'const a = Math.floor(x);', 'const a = +x;', 'const a = Number.parseFloat(x);',
  ];
  for (const code of ruins) assert.ok((await lint(code)).length >= 1, `deveria reprovar: ${code}`);
  const fine = ["const a = new Date('2026-10-01');", 'const a = 10n;', "const a = require('./money').money('1.5');", 'const a = Number.isInteger(x);', 'const n = 100;'];
  for (const code of fine) assert.deepEqual(await lint(code), [], `não deveria reprovar: ${code}`);
  const outside = (await eslint.lintText("'use strict';\nconst a = Date.now();\n", { filePath: path.join(API_ROOT, 'src', 'x.js') }))[0].messages;
  assert.ok(!outside.some((m) => m.ruleId === RULE), 'a regra vale só na pasta das fórmulas');
  const real = await eslint.lintFiles(['src/modules/analytics/metrics/formulas/**/*.js']);
  assert.deepEqual(real.flatMap((r) => r.messages), [], 'as fórmulas reais passam no lint');
});

test('m9d605 divisão por zero devolve nulo e INCOMPLETE', () => {
  assert.deepEqual(money.percent('10', '0'), { value: null, status: 'INCOMPLETE' });
  assert.deepEqual(money.percent('0', '0'), { value: null, status: 'INCOMPLETE' });
  assert.deepEqual(money.percent('1', '8'), { value: '12.50', status: 'OK' });
  assert.deepEqual(money.percent('2469', '20000'), { value: '12.35', status: 'OK' });
  assert.equal(money.div(money.dec('1'), money.dec('0')), null);
  assert.deepEqual(money.ratioResult(null), { value: null, status: 'INCOMPLETE' });
});

test('m9d605 roundingDelta é exposto quando partes não fecham', () => {
  const r = money.sumWithRoundingDelta(['10.005', '20.004', '30.005']);
  assert.deepEqual(r, { total: '60.01', parts: ['10.01', '20.00', '30.01'], roundingDelta: '-0.01' });
  const closed = money.sumWithRoundingDelta(['10.10', '20.20']);
  assert.deepEqual(closed, { total: '30.30', parts: ['10.10', '20.20'], roundingDelta: '0.00' });
});

test('m9d605 fórmula sem arquivo de teste derruba o CI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d605-'));
  try {
    const formulas = path.join(root, 'formulas');
    const tests = path.join(root, 'tests');
    fs.mkdirSync(formulas);
    fs.mkdirSync(tests);
    fs.writeFileSync(path.join(formulas, 'caixa.js'), "module.exports = { id: 'fin.a', version: 1, compute: () => ({ value: '0' }) };\n");
    fs.writeFileSync(path.join(formulas, 'money.js'), '// utilitário\n');
    fs.writeFileSync(path.join(formulas, '_privada.js'), '// ignorada\n');
    assert.deepEqual(findFormulasWithoutTests(formulas, tests), ['caixa.js']);
    fs.writeFileSync(path.join(tests, 'caixa.formula.test.js'), '// tabela\n');
    assert.deepEqual(findFormulasWithoutTests(formulas, tests), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(findFormulasWithoutTests(FORMULAS_DIR, path.join(__dirname, 'analytics', 'formulas')), [], 'toda fórmula real tem teste de tabela');
});

test('m9d605 meio para cima aplicado de forma igual em todo KPI (0,125 vira 0,13; -0,125 vira -0,13)', () => {
  assert.equal(money.money('0.125'), '0.13');
  assert.equal(money.money('-0.125'), '-0.13');
  assert.equal(money.round('0.125', 2), '0.13');
  assert.equal(money.round('-0.125', 2), '-0.13');
  assert.equal(money.hours('0.25'), '0.3');
  assert.equal(money.hours('-0.25'), '-0.3');
  assert.equal(money.percent('125', '100000').value, '0.13');
  assert.equal(money.percent('-125', '100000').value, '-0.13');
  assert.equal(money.count('7'), '7');
  assert.throws(() => money.count('7.5'), (e) => e.code === 'ANALYTICS_FORMULA_INPUT_INVALID');
});

test('m9d605 entrada não numérica é recusada com 422 e fórmula não determinística com 500', () => {
  for (const bad of ['abc', '', null, undefined, NaN, 1.5, {}, '1,5', 'Infinity']) {
    assert.throws(() => money.dec(bad), (e) => e.statusCode === 422 && e.code === 'ANALYTICS_FORMULA_INPUT_INVALID', String(bad));
  }
  const clock = { id: 'x.relogio', version: 1, compute: () => ({ value: String(Date.now()) }), testCases: [{ name: 'a', input: [], expected: { value: '1' } }] };
  const rnd = { id: 'x.sorteio', version: 1, compute: () => ({ value: String(Math.random()) }), testCases: [{ name: 'a', input: [], expected: { value: '1' } }] };
  const date = { id: 'x.data', version: 1, compute: () => ({ value: new Date().toISOString() }), testCases: [{ name: 'a', input: [], expected: { value: '1' } }] };
  const stateful = (() => { let n = 0; return { id: 'x.estado', version: 1, compute: () => ({ value: String(n += 1) }), testCases: [{ name: 'a', input: [], expected: { value: '1' } }] }; })();
  for (const f of [clock, rnd, date, stateful]) {
    assert.throws(() => assertDeterministicFormula(f), (e) => e.statusCode === 500 && e.code === 'ANALYTICS_FORMULA_NOT_DETERMINISTIC', f.id);
  }
  const fine = { id: 'x.ok', version: 1, compute: (r) => ({ value: String(r.length) }), testCases: [{ name: 'a', input: [1, 2], expected: { value: '2' } }] };
  assert.doesNotThrow(() => assertDeterministicFormula(fine));
  assert.equal(typeof Date.now(), 'number', 'o relógio global volta ao normal');
  runFormulaTable({ id: 'fin.m9d605_tabela', compute: (rows) => ({ value: money.money(money.sum(rows.map((r) => r.v))) }) }, [
    { kind: 'empty', name: 'sem linhas', input: [], expected: { value: '0.00' } },
    { kind: 'single', name: 'uma linha', input: [{ v: '5' }], expected: { value: '5.00' } },
    { kind: 'typical', name: 'três linhas', input: [{ v: '1.10' }, { v: '2.20' }, { v: '3.30' }], expected: { value: '6.60' } },
    { kind: 'period_edge', name: 'valor negativo do estorno', input: [{ v: '10' }, { v: '-10' }], expected: { value: '0.00' } },
    { kind: 'rounding', name: 'meio para cima no fim', input: [{ v: '0.335' }, { v: '0.335' }, { v: '0.335' }], expected: { value: '1.01' } },
  ]);
});
