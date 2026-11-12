'use strict';

const AppError = require('../../utils/AppError');

/**
 * Teto de tamanho da redação do perfil da IA (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-22).
 *
 * A redação é linear (DI-M9R-17), mas a constante do pior caso é alta: a regra de endereço, com "rua" seguida de 61 espaços repetida, custa de 1,7
 * a 2,1 s por MB com a máquina carregada (rodada 7). O texto que chega à redação da IA vem do cliente (conversa com a NAY, memória, avaliação,
 * documento da base de conhecimento) e só tinha o limite do leitor do corpo (28 MB, uns 55 s de laço de eventos preso). Este teto vale para TODA
 * chamada de `redactForAi` e `redactDeepForAi` (soma dos textos da estrutura), no ponto único da biblioteca: acima dele a redação recusa com 400
 * `AI_TEXT_TOO_LARGE` antes de começar, e o pior caso fica em cerca de 2 s. Variável de ambiente `REDACTION_AI_MAX_CHARS` (padrão 1.048.576;
 * faixa 65.536 a 16.777.216): é limite do servidor, conferido em código sem empresa (biblioteca, jobs).
 */
const PADRAO = 1048576;
const FAIXA = [65536, 16777216];

function limiteDaRedacaoIa(env = process.env) {
  const n = Number(env.REDACTION_AI_MAX_CHARS);
  return env.REDACTION_AI_MAX_CHARS !== undefined && Number.isInteger(n) && n >= FAIXA[0] && n <= FAIXA[1] ? n : PADRAO;
}

const erroDeTamanho = (max) => new AppError(`O texto passa do tamanho que a NAY processa (${max} caracteres).`, 400, 'AI_TEXT_TOO_LARGE', { maxChars: max });

function assertTextoDaIa(texto, max = limiteDaRedacaoIa()) {
  if (typeof texto === 'string' && texto.length > max) throw erroDeTamanho(max);
}

/** Soma dos textos (e números) da estrutura, até `profundidade` níveis, parando assim que passa do teto. Iterativo. */
function assertEstruturaDaIa(valor, profundidade, max = limiteDaRedacaoIa()) {
  const pilha = [[valor, 0]];
  let total = 0;
  while (pilha.length > 0) {
    const [atual, nivel] = pilha.pop();
    if (typeof atual === 'string') total += atual.length;
    else if (typeof atual === 'number' || typeof atual === 'bigint') total += 24;
    else if (atual && typeof atual === 'object' && !Buffer.isBuffer(atual) && !(atual instanceof Date) && nivel < profundidade) {
      for (const chave of Object.keys(atual)) { total += chave.length; pilha.push([atual[chave], nivel + 1]); }
    }
    if (total > max) throw erroDeTamanho(max);
  }
}

module.exports = { limiteDaRedacaoIa, assertTextoDaIa, assertEstruturaDaIa, PADRAO, FAIXA };
