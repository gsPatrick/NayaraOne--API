'use strict';

// M9-D705 etapa 4 (metric formula tests): teste de tabela da fórmula legalContractsSigned (M9-D710), que o portão do CI exige - vazio, um registro, típico, borda de período e arredondamento.
const { runFormulaTable } = require('../formulaTable');
const formula = require('../../../src/features/analytics/metrics/formulas/legalContractsSigned');

runFormulaTable(formula, formula.testCases);
