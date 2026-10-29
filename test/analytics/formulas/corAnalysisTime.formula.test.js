'use strict';

// M9-D660 — teste de tabela da fórmula corAnalysisTime (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/corAnalysisTime');

runFormulaTable(formula, formula.testCases);
