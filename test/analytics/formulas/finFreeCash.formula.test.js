'use strict';

// M9-D620 — teste de tabela da fórmula finFreeCash (exigido pelo passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/finFreeCash');

runFormulaTable(formula, formula.testCases);
