'use strict';

/**
 * Aparar pontuação do fim de um endereço achado (M9-D433, rodada 5). Varredura caractere a caractere, de trás para frente, uma única passada: sem expressão
 * regular ancorada no fim (`/[.,;:!?]+$/` é quadrática num texto com milhares de pontos seguidos de uma letra).
 */
const TAIL_PUNCTUATION = '.,;:!?_-*=';
const SENTENCE_PUNCTUATION = '.,;:!?';

function trimTail(text, chars = TAIL_PUNCTUATION) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

module.exports = { trimTail, TAIL_PUNCTUATION, SENTENCE_PUNCTUATION };
