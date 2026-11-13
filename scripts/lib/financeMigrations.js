'use strict';

/**
 * M4-D140 (Guia do Marco 4, §2: src/modules/finance/infrastructure/db/migrations/): critério único que diz se
 * uma migration é do Financeiro. Usado pelo gerador do retrato (scripts/m4d140/gerarSnapshots.js) e pelo teste
 * de estrutura (test/m4d140.estruturaFinanceiro.test.js), que reprova migration financeira na pasta raiz.
 *
 * É financeira a migration que cria, altera, apaga ou concede/revoga acesso a um objeto do schema `finance`
 * (DDL ou DML que nomeia `finance.<objeto>`, `"finance"."<objeto>"`, `{ tableName, schema: 'finance' }`,
 * a lista `['finance', '<tabela>', ...]` ou a constante `= 'finance'`). Não contam: comentários, chave
 * estrangeira que só APONTA para uma tabela do Financeiro (`REFERENCES finance.x`, `references: { model:
 * { schema: 'finance' } }`), códigos de permissão com três partes (`finance.entries.approve`) e read models
 * de outros schemas (`analytics.rm_finance_*`).
 */

function semComentarios(fonte) {
  return String(fonte)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function semReferenciasEstrangeiras(fonte) {
  return fonte
    .replace(/REFERENCES\s+"?finance"?\s*\.\s*"?[\w$]+"?/gi, '')
    .replace(/references\s*:\s*\{\s*model\s*:\s*\{[^}]*\}[^}]*\}/g, '');
}

const QUALIFICADO = /(^|[^\w.])"?finance"?\s*\.\s*(?:"[^"]+"|\$\{|[a-z_][a-z0-9_]*)(?!\s*\.\s*[a-z_])(?!:)/i;
const SCHEMA_OPCAO = /schema\s*:\s*['"]finance['"]/;
const TUPLA = /\[\s*['"]finance['"]\s*,/;
const CONSTANTE = /=\s*['"]finance['"]/;

/** true quando o código da migration mexe num objeto do schema finance (ver critério acima). */
function isFinanceMigration(fonte) {
  const codigo = semReferenciasEstrangeiras(semComentarios(fonte));
  return QUALIFICADO.test(codigo) || SCHEMA_OPCAO.test(codigo) || TUPLA.test(codigo) || CONSTANTE.test(codigo);
}

module.exports = { isFinanceMigration };
