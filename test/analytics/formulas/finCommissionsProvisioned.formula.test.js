'use strict';

// M9-D623 — teste de tabela da fórmula finCommissionsProvisioned (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/finCommissionsProvisioned');

runFormulaTable(formula, formula.testCases);
