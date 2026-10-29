'use strict';

// M9-D650 — teste de tabela da fórmula obraProgressVsSchedule (passo "metric formula tests" do CI, M9-D605): vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/obraProgressVsSchedule');

runFormulaTable(formula, formula.testCases);
