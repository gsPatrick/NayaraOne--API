'use strict';

/**
 * M9-D704/M9-D705 — portões da suíte adversarial: os 15 nomes existem no arquivo e nenhum teste da suíte (nem das donas dos testes nomeados) é
 * pulado (`skip`, `todo`, `only`). A ausência de um nome reprova a etapa do pipeline.
 */
const fs = require('node:fs');

/** Nomes (exatos) que não aparecem como `test('<nome>'` no texto do arquivo. */
function nomesAusentes(texto, nomes) {
  return nomes.filter((n) => !texto.includes(`test('${n}'`));
}

const PADROES = [
  [/\b(?:test|it|describe|suite)\s*\.\s*(skip|only|todo)\b/g, (m) => `${m[1]} (chamada)`],
  [/[{,]\s*(skip|only|todo)\s*:\s*(?!false\b)/g, (m) => `${m[1]} (opção)`],
];

/** Lista `{ arquivo, linha, achado }` de cada skip/only/todo literal; o CI e o lint reprovam qualquer um. */
function acharSkipOnly(arquivos) {
  const achados = [];
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    for (const [re, descreve] of PADROES) {
      for (const m of texto.matchAll(re)) achados.push({ arquivo, linha: texto.slice(0, m.index).split('\n').length, achado: descreve(m) });
    }
  }
  return achados;
}

module.exports = { nomesAusentes, acharSkipOnly };
