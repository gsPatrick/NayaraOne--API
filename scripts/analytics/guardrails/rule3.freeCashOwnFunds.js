'use strict';

/**
 * Regra 3 — "Não misturar caixa próprio/terceiros". Toda fórmula de caixa livre (`free_cash`/`caixa_livre` no id ou no nome do arquivo)
 * precisa filtrar `is_third_party_funds` e só ler linhas com valor `false`. O teste de números da fórmula é da M9-D620.
 */
const fs = require('node:fs');
const path = require('node:path');
const { API_ROOT, listFiles, violation } = require('./files');

const FREE_CASH = /free_?cash|caixa_?livre/i;
const OWN_ONLY = /is_third_party_funds\s*(?:===?|==)\s*false|!\s*[\w$.]*\bis_third_party_funds\b|is_third_party_funds\s*!==?\s*true/;
const FORMULAS = path.join('src', 'features', 'analytics', 'metrics', 'formulas');

function checkRule3(root = API_ROOT, formulasDir = path.join(root, FORMULAS)) {
  const out = [];
  const files = listFiles(formulasDir, /\.js$/).filter((f) => !/\.test\.js$|money\.js$|\/_/.test(f));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!FREE_CASH.test(path.basename(file)) && !FREE_CASH.test((/\bid:\s*['"]([^'"]+)['"]/.exec(text) || [])[1] || '')) continue;
    if (!OWN_ONLY.test(text)) out.push(violation(3, path.relative(root, file), 'Fórmula de caixa livre sem filtrar is_third_party_funds = false (mistura caixa próprio e de terceiros).'));
  }
  return { scanned: files.length, violations: out };
}

module.exports = { checkRule3 };
