'use strict';

// M9-D632/M9-D633 — teste de tabela da fórmula radarMatches (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/radarMatches');

runFormulaTable(formula, formula.testCases);
