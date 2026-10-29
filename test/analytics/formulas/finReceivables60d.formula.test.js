'use strict';

// M9-D621 — teste de tabela da fórmula finReceivables60d (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/finReceivables60d');

runFormulaTable(formula, formula.testCases);
