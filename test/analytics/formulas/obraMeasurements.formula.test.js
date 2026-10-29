'use strict';

// M9-D651 — teste de tabela da fórmula obraMeasurements (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/obraMeasurements');

runFormulaTable(formula, formula.testCases);
