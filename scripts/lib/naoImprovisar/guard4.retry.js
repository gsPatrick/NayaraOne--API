'use strict';

const { API_ROOT, violation, listJs, codeLines } = require('./common');

const LACO = /^\s*(?:for|while)\s*\(|^\s*do\s*\{/;
const RETRY = /\b(retry|retries|attempt|attempts|tentativa|tentativas|backoff)\b/i;

/** Classificador padrão do motor de envios (M9-D216): timeout em operação perigosa não vira nova tentativa. */
function classificadorPadrao() {
  return require('../../../src/features/integrations/dispatch/retry/retry.classify').classifyDispatchError;
}

/**
 * Regra 4: "Não retry cego após timeout crítico". (a) o motor classifica timeout em operação DANGEROUS como UNKNOWN (consulta antes de repetir), nunca como TRANSIENT;
 * (b) nenhum laço de repetição escrito à mão dentro de `providers/**`: a repetição é do motor de envios, com classe e backoff.
 */
function scan({ root = API_ROOT, classify = classificadorPadrao() } = {}) {
  const achados = [];
  const r = classify({ code: 'ETIMEDOUT', name: 'TimeoutError' }, null, { opClass: 'DANGEROUS', idempotent: false });
  if (!r || r.class !== 'UNKNOWN') achados.push(violation(4, 'src/features/integrations/dispatch/retry/retry.classify.js', 1, `Timeout em operação DANGEROUS foi classificado como ${r && r.class}: o motor deve consultar o fornecedor (UNKNOWN) antes de qualquer repetição.`));
  for (const rel of listJs(root, 'src/features/integrations/providers')) {
    const linhas = codeLines(root, rel);
    linhas.forEach((linha, i) => {
      if (LACO.test(linha) && linhas.slice(Math.max(0, i - 1), i + 5).some((l) => RETRY.test(l))) achados.push(violation(4, rel, i + 1, 'Laço de repetição manual em provider: a repetição é do motor de envios (classe de erro, backoff e consulta antes de repetir).', linha));
    });
  }
  return achados;
}

module.exports = { rule: 4, name: 'retry_cego_apos_timeout', scan };
