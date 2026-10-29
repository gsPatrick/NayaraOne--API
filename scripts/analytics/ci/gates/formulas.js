'use strict';

/**
 * M9-D705 etapa 4 (metric formula tests) — portão do conteúdo dos testes de fórmula (critério transferido da M9-D605): toda fórmula do registry
 * tem `<fórmula>.formula.test.js`, o arquivo não é vazio e usa o ajudante `test/analytics/formulaTable.js` (`runFormulaTable`), que exige os 5
 * tipos de caso mínimos (vazio, um registro, típico, borda de período, arredondamento) e roda cada caso.
 */
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..', '..', '..', '..');
const FORMULAS = path.join(API_ROOT, 'src', 'features', 'analytics', 'metrics', 'formulas');
const TESTES = path.join(API_ROOT, 'test', 'analytics', 'formulas');

function avaliarTestesDeFormula({ formulasDir = FORMULAS, testsDir = TESTES, isFormulaFile = require('../../../../src/features/analytics/metrics/formulaCatalog').isFormulaFile } = {}) {
  const problemas = [];
  if (!fs.existsSync(formulasDir)) return { ok: true, problemas };
  for (const file of fs.readdirSync(formulasDir).filter(isFormulaFile).sort()) {
    const nome = `${path.basename(file, '.js')}.formula.test.js`;
    const alvo = path.join(testsDir, nome);
    if (!fs.existsSync(alvo)) { problemas.push(`${file}: fórmula sem teste de tabela (${nome}).`); continue; }
    const texto = fs.readFileSync(alvo, 'utf8');
    if (!texto.trim()) problemas.push(`${nome}: arquivo vazio.`);
    else if (!/formulaTable/.test(texto) || !/\brunFormulaTable\s*\(/.test(texto)) problemas.push(`${nome}: não usa o ajudante formulaTable (runFormulaTable), que confere os 5 tipos de caso.`);
  }
  return { ok: problemas.length === 0, problemas };
}

module.exports = { avaliarTestesDeFormula };
