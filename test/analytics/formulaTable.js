'use strict';

// M9-D605 (3.3) — ajudante dos testes de tabela das fórmulas (`*.formula.test.js`): cada fórmula declara no mínimo 5 casos que cobrem os
// 5 tipos (vazio, um registro, caso típico, borda de período e arredondamento). Cada caso: { kind, name, input, params, expected }.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonical } = require('../../src/modules/analytics/metrics/formulaCatalog');

const KINDS = ['empty', 'single', 'typical', 'period_edge', 'rounding'];

function runFormulaTable(formula, cases) {
  const kinds = new Set(cases.map((c) => c.kind));
  test(`${formula.id}: a tabela cobre os 5 tipos de caso (vazio, um registro, típico, borda de período, arredondamento)`, () => {
    assert.ok(cases.length >= 5, 'mínimo de 5 casos');
    for (const kind of KINDS) assert.ok(kinds.has(kind), `falta caso do tipo ${kind}`);
  });
  for (const c of cases) {
    test(`${formula.id}: ${c.kind} - ${c.name}`, () => {
      assert.equal(canonical(formula.compute(c.input, c.params || {})), canonical(c.expected));
    });
  }
}

module.exports = { runFormulaTable, KINDS };
