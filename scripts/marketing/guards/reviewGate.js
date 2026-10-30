'use strict';

const { ler, posicao, linhaDe } = require('./source');

const NOME = 'guard_review_after_case_resolved';
const ARQUIVO = 'automations/reviews/review.positive.js';

/** Pedido de avaliação só sem ocorrência aberta: a conferência vem antes de criar o pedido e antes de enviar. */
function verificar(raiz) {
  const texto = ler(raiz, ARQUIVO);
  if (texto === null) return [{ arquivo: ARQUIVO, linha: 1, regra: 'o fluxo de pedido de avaliação não existe' }];
  const problemas = [];
  const confere = (nome) => {
    const corpoDe = new RegExp(`async function ${nome}\\b[\\s\\S]*?\\n}\\n`).exec(texto);
    if (!corpoDe) return problemas.push({ arquivo: ARQUIVO, linha: 1, regra: `a função ${nome} do pedido de avaliação não existe` });
    const inicio = corpoDe.index;
    const aberta = posicao(corpoDe[0], /\bhasOpenCase\(/);
    const envio = posicao(corpoDe[0], /\b(?:ports\.sendMessage|repo\.insert)\(/);
    if (aberta === -1 || (envio !== -1 && aberta > envio)) problemas.push({ arquivo: ARQUIVO, linha: linhaDe(texto, inicio), regra: `${nome} deve conferir ocorrência aberta (hasOpenCase) antes de criar ou enviar o pedido de avaliação` });
    return null;
  };
  confere('positive');
  confere('deliver');
  return problemas;
}

module.exports = { NOME, verificar };
