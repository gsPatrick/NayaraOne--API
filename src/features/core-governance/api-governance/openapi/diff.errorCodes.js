'use strict';

const { RULE } = require('./openapi.constants');
const { change } = require('./diff.schema');

/**
 * Regra 9 (M9-D840 §3.2): o código de erro estável de uma condição documentada não muda. A condição é a resposta (`status`) da operação; o código vem em `x-error-code`. Contra a base: o
 * mesmo status mantém o mesmo código. Contra o catálogo (docs/ERROR_CODES.md da M9-D843), quando informado: o código da candidata existe nele.
 */
function codesOf(operation) {
  const map = new Map();
  for (const [status, response] of Object.entries(operation.responses || {})) if (response && typeof response['x-error-code'] === 'string') map.set(status, response['x-error-code']);
  return map;
}

function diffErrorCodes(base, cand, where, catalog) {
  const out = [];
  const before = codesOf(base.operation);
  const after = codesOf(cand.operation);
  for (const [status, code] of before) {
    if (after.has(status) && after.get(status) !== code) out.push(change(RULE.ERROR_CODE_CHANGED, 9, where, `código do ${status} mudou de ${code} para ${after.get(status)}`));
  }
  if (catalog) for (const [status, code] of after) if (!catalog.has(code)) out.push(change(RULE.ERROR_CODE_CHANGED, 9, where, `código ${code} (${status}) não consta no catálogo de erros`));
  return out;
}

/** Lê o catálogo gerado pela M9-D843 (docs/ERROR_CODES.md): linhas de tabela `| CODIGO | status | mensagem | módulo | versão | descontinuado |`. Devolve um Set de códigos. */
function parseErrorCatalog(markdown) {
  const codes = new Set();
  for (const line of String(markdown).split('\n')) {
    const match = /^\|\s*`?([A-Z][A-Z0-9_]+)`?\s*\|\s*\d{3}\s*\|/.exec(line);
    if (match) codes.add(match[1]);
  }
  return codes;
}

module.exports = { diffErrorCodes, parseErrorCatalog };
