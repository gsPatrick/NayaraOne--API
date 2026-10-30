'use strict';

// M9-D605 (reabertura L-3) — entrada malformada das fórmulas: recusada com 422 ANALYTICS_FORMULA_INPUT_INVALID (nunca "OK, valor 0" nem TypeError cru);
// percentual com base negativa é INCOMPLETE. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFormulaCatalog } = require('../../../src/features/analytics/metrics/formulaCatalog');
const { runFormula, expectsRows } = require('../../../src/features/analytics/metrics/formulaRun');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const catalog = getFormulaCatalog();
const formulas = catalog.ids().map((id) => catalog.get(id));
const refused = (fn) => assert.throws(fn, (e) => { assert.equal(e.statusCode, 422); assert.equal(e.code, 'ANALYTICS_FORMULA_INPUT_INVALID'); return true; });

test('m9d605 entrada nula, indefinida, texto, número ou lista dá 422 em toda fórmula do catálogo', () => {
  assert.ok(formulas.length >= 90, `catálogo com ${formulas.length} fórmulas`);
  for (const f of formulas) {
    for (const bad of [null, undefined, 'texto', 42, true]) refused(() => runFormula(f, bad, {}));
    if (!f.testCases.some((c) => Array.isArray(c.input))) refused(() => runFormula(f, [], {}));
    refused(() => runFormula(f, [null], {}));
  }
});

test('m9d605 fórmula de linhas recusa {}, texto ou item nulo no lugar das linhas, e aceita rows vazio como o caso explícito de vazio', () => {
  const withRows = formulas.filter(expectsRows);
  assert.ok(withRows.length >= 40, `${withRows.length} fórmulas de linhas`);
  for (const f of withRows) {
    refused(() => runFormula(f, {}, {}));
    refused(() => runFormula(f, { rows: 'texto' }, {}));
    refused(() => runFormula(f, { rows: [null] }, {}));
    refused(() => runFormula(f, { rows: { a: 1 } }, {}));
    const empty = f.testCases.find((c) => c.kind === 'empty');
    if (empty) assert.deepEqual(runFormula(f, empty.input, empty.params || {}), f.compute(empty.input, empty.params || {}), `${f.id}: vazio continua valendo`);
  }
});

test('m9d605 todos os casos de teste do catálogo continuam passando pela porta única', () => {
  for (const f of formulas) {
    for (const c of f.testCases) assert.deepEqual(runFormula(f, structuredClone(c.input), c.params || {}), f.compute(structuredClone(c.input), c.params || {}), `${f.id}: ${c.name}`);
  }
});

test('m9d605 percentual com base negativa ou zero é INCOMPLETE; numerador negativo segue valendo', () => {
  assert.deepEqual(money.percent('5', '-10'), { value: null, status: 'INCOMPLETE' });
  assert.deepEqual(money.percent('-5', '-10'), { value: null, status: 'INCOMPLETE' });
  assert.deepEqual(money.percent('5', '0'), { value: null, status: 'INCOMPLETE' });
  assert.deepEqual(money.percent('-5', '10'), { value: '-50.00', status: 'OK' });
  assert.deepEqual(money.percent('1', '8'), { value: '12.50', status: 'OK' });
});
