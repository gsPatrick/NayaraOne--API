'use strict';

// M9-D680 — teste de tabela da fórmula techQueuesDlq (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/techQueuesDlq');

runFormulaTable(formula, formula.testCases);
