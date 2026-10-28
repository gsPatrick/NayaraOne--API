'use strict';

/**
 * M9-D605 (3.3) — passo de CI "metric formula tests": toda fórmula de src/modules/analytics/metrics/formulas/ precisa de um arquivo de
 * teste de tabela `<fórmula>.formula.test.js` em test/analytics/formulas/. Sai com código 1 e lista as fórmulas sem teste. O M9-D705
 * chama este script no pipeline.
 */
const fs = require('node:fs');
const path = require('node:path');
const { isFormulaFile } = require('../../src/modules/analytics/metrics/formulaCatalog');

const DEFAULT_FORMULAS = path.join(__dirname, '..', '..', 'src', 'modules', 'analytics', 'metrics', 'formulas');
const DEFAULT_TESTS = path.join(__dirname, '..', '..', 'test', 'analytics', 'formulas');

/** Arquivos de fórmula (ex.: "freeCash.js") sem o "freeCash.formula.test.js" correspondente. */
function findFormulasWithoutTests(formulasDir = DEFAULT_FORMULAS, testsDir = DEFAULT_TESTS) {
  if (!fs.existsSync(formulasDir)) return [];
  return fs.readdirSync(formulasDir).filter(isFormulaFile).sort()
    .filter((file) => !fs.existsSync(path.join(testsDir, `${path.basename(file, '.js')}.formula.test.js`)));
}

if (require.main === module) {
  const missing = findFormulasWithoutTests();
  if (missing.length) {
    console.error(`Fórmula sem teste de tabela (*.formula.test.js): ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('OK: toda fórmula do registry tem teste de tabela.');
}

module.exports = { findFormulasWithoutTests };
