'use strict';

// M9-D624 — teste de tabela da fórmula finReconciliationsPending (exigido pelo passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/finReconciliationsPending');

runFormulaTable(formula, formula.testCases);
