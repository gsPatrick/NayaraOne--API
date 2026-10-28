'use strict';

/**
 * M9-D603/D604 — checagens de publicação compartilhadas pela versão 1 e pelas novas versões: o read model de origem existe e a
 * fórmula existe no código com os testes verdes (dry-run; devolve o hash gravado em formula_test_hash).
 */
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { runFormulaTests } = require('./formulaCatalog');
const { assertDeterministicFormula } = require('./formulaDeterminism');

async function assertReadModelExists(name, transaction) {
  const [[row]] = await sequelize.query('SELECT to_regclass(:n) IS NOT NULL AS ok', { replacements: { n: `analytics.${name}` }, transaction });
  if (!row.ok) throw AppError.unprocessable('O read model de origem não existe.', 'ANALYTICS_READ_MODEL_NOT_FOUND', { sourceReadModel: name });
}

function checkFormula(input, catalog) {
  const formula = catalog.get(input.formulaId);
  if (!formula) throw AppError.unprocessable('A fórmula informada não existe.', 'ANALYTICS_FORMULA_NOT_FOUND', { formulaId: input.formulaId });
  const result = runFormulaTests(formula);
  if (!result.ok) {
    throw AppError.unprocessable('Os testes da fórmula não passaram; ela não pode ser publicada.', 'ANALYTICS_FORMULA_TESTS_FAILED', { falhas: result.failures });
  }
  assertDeterministicFormula(formula);
  return result.hash;
}

module.exports = { assertReadModelExists, checkFormula };
