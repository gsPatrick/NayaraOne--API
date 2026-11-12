'use strict';

/**
 * Texto que o banco grava (verificação independente do Marco 9, rodada 6, 12/11/2026; DI-M9R-15).
 *
 * O Postgres recusa dois tipos de caractere que o JSON e o JavaScript aceitam:
 * - o caractere nulo (U+0000): numa coluna de texto dá "invalid byte sequence for encoding UTF8: 0x00" e num jsonb "unsupported Unicode escape sequence";
 * - a metade solta de um par sub-rogado (U+D800 a U+DFFF sem o par): não existe em UTF-8. Num jsonb dá "invalid input syntax for type json"; numa coluna de
 *   texto o driver troca a metade por U+FFFD em silêncio (o texto gravado não é o enviado).
 * Esses caracteres não têm uso legítimo num texto do sistema; a entrada que os traz é recusada antes de chegar ao banco.
 */
const isStorableText = (texto) => typeof texto !== 'string' || (texto.indexOf('\u0000') === -1 && texto.isWellFormed());

/**
 * Primeiro texto (valor ou nome de campo) que o banco não grava, em qualquer profundidade de `valor`. Devolve o nome do campo de topo que o contém
 * (`text`, `templateVars`, ...), '' quando o próprio valor é o texto, ou null quando está tudo certo. Percurso iterativo (sem recursão: o corpo pode ter
 * milhares de níveis) e linear no tamanho. Buffer e outros objetos que não são de dados (Date, por exemplo) não são percorridos.
 */
function findUnstorableText(valor) {
  const pilha = [[valor, '']];
  while (pilha.length > 0) {
    const [atual, campo] = pilha.pop();
    if (typeof atual === 'string') {
      if (!isStorableText(atual)) return campo;
    } else if (atual && typeof atual === 'object' && !Buffer.isBuffer(atual) && (Array.isArray(atual) || isPlainObject(atual))) {
      for (const chave of Object.keys(atual)) {
        const topo = campo === '' ? chave : campo;
        if (!isStorableText(chave)) return topo;
        pilha.push([atual[chave], topo]);
      }
    }
  }
  return null;
}

/** Objeto de dados (o que o JSON.parse e o leitor de formulário criam): protótipo Object.prototype ou nenhum. */
function isPlainObject(valor) {
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

module.exports = { isStorableText, findUnstorableText };
