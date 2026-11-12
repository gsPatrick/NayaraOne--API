'use strict';

const AppError = require('../utils/AppError');

/**
 * Forma do pedido, conferida na porta da API para TODAS as rotas (verificação independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-18).
 *
 * O leitor de JSON aceita qualquer aninhamento que caiba em 28 MB (`{"a":{"a":...}}` com 500 mil níveis) e qualquer número que o JSON escreva
 * (`1e400`, que o JavaScript lê como Infinity). Daí em diante, o código recursivo que percorre o corpo (hash da idempotência, redação, montagem da
 * resposta de erro, `Array.join`, `JSON.stringify`) estourava a pilha e a rota dava 500; num caso, a resposta de erro falhava e o processo da API caía.
 * Esta porta confere, logo depois dos leitores do corpo e antes de qualquer rota:
 * - profundidade: no máximo `REQUEST_BODY_MAX_DEPTH` objetos ou listas um dentro do outro (padrão 64). O maior aninhamento legítimo medido é 5
 *   (os 1.003 corpos aceitos com 2xx pela bateria completa de testes, em 180 rotas de escrita); 64 deixa folga de mais de dez vezes;
 * - tamanho da estrutura: no máximo `REQUEST_BODY_MAX_NODES` valores no corpo inteiro (padrão 500.000; o maior corpo medido tem 44 valores, e o
 *   limite só existe para que nenhum percurso do corpo custe mais que o leitor de 28 MB já custa);
 * - número: só número finito (`1e400` e `-1e400` viram Infinity no leitor e não são um valor que o cliente possa ter querido mandar).
 * O percurso é iterativo (sem recursão) e para no primeiro problema. Resposta: 400 com `REQUEST_BODY_TOO_DEEP`, `REQUEST_BODY_TOO_COMPLEX` ou
 * `REQUEST_BODY_NUMBER_OUT_OF_RANGE`; o nome do campo de topo vai na mensagem e em `details.fields`, nunca o valor.
 *
 * Os limites são do servidor (variáveis de ambiente), não da empresa: valem antes de se saber quem pede, inclusive nas rotas públicas.
 */
const PADRAO = Object.freeze({ maxDepth: 64, maxNodes: 500000 });
const FAIXA = Object.freeze({ maxDepth: [8, 1000], maxNodes: [1000, 5000000] });

/** Inteiro da variável de ambiente dentro da faixa; ausente ou inválido vale o padrão. */
function inteiroDoAmbiente(valor, padrao, [min, max]) {
  const n = Number(valor);
  if (valor === undefined || valor === '' || !Number.isInteger(n) || n < min || n > max) return padrao;
  return n;
}

/** Limites em vigor (lidos a cada pedido: trocar a variável vale sem reiniciar o código de teste). */
function limitesDaForma(env = process.env) {
  return {
    maxDepth: inteiroDoAmbiente(env.REQUEST_BODY_MAX_DEPTH, PADRAO.maxDepth, FAIXA.maxDepth),
    maxNodes: inteiroDoAmbiente(env.REQUEST_BODY_MAX_NODES, PADRAO.maxNodes, FAIXA.maxNodes),
  };
}

const ehEstrutura = (v) => v !== null && typeof v === 'object' && !Buffer.isBuffer(v);

/**
 * Primeiro problema de forma em `valor`, ou null. Devolve { motivo: 'profundidade' | 'tamanho' | 'numero', campo } (`campo` é o nome do campo de
 * topo que contém o problema; '' quando é o próprio valor). Iterativo e linear: cada valor é visitado uma vez e a contagem para no limite.
 */
function inspecionarForma(valor, { maxDepth, maxNodes } = PADRAO) {
  const pilha = [[valor, 0, '']];
  let nos = 1;
  while (pilha.length > 0) {
    const [atual, nivel, campo] = pilha.pop();
    if (typeof atual === 'number') {
      if (!Number.isFinite(atual)) return { motivo: 'numero', campo };
      continue;
    }
    if (!ehEstrutura(atual)) continue;
    if (nivel >= maxDepth) return { motivo: 'profundidade', campo };
    if (Array.isArray(atual)) {
      nos += atual.length;
      if (nos > maxNodes) return { motivo: 'tamanho', campo };
      for (let i = 0; i < atual.length; i += 1) pilha.push([atual[i], nivel + 1, campo === '' ? String(i) : campo]);
    } else {
      const chaves = Object.keys(atual);
      nos += chaves.length;
      if (nos > maxNodes) return { motivo: 'tamanho', campo };
      for (const chave of chaves) pilha.push([atual[chave], nivel + 1, campo === '' ? chave : campo]);
    }
  }
  return null;
}

/** Nome do campo para a mensagem: vem do cliente, então sai cortado em 64 e sem caractere que o banco não grava. */
function nomeVisivel(campo) {
  const texto = String(campo).toWellFormed().split('\u0000').join('�');
  return texto.length > 64 ? `${texto.slice(0, 64)}…` : texto;
}

const PARTES = Object.freeze({ body: 'corpo', query: 'consulta' });

function erroDaForma({ motivo, campo }, parte, limites) {
  const nome = campo === '' ? '' : nomeVisivel(campo);
  const fields = [nome === '' ? PARTES[parte] : nome];
  const onde = nome === '' ? `O ${PARTES[parte]} da requisição` : `O campo "${nome}"${parte === 'query' ? ' da consulta' : ''}`;
  if (motivo === 'profundidade') {
    return AppError.badRequest(`${onde} passa da profundidade aceita (${limites.maxDepth} níveis de objetos ou listas).`, 'REQUEST_BODY_TOO_DEEP',
      { fields, part: parte, maxDepth: limites.maxDepth });
  }
  if (motivo === 'tamanho') {
    return AppError.badRequest(`O ${PARTES[parte]} da requisição tem valores demais (no máximo ${limites.maxNodes}).`, 'REQUEST_BODY_TOO_COMPLEX',
      { fields, part: parte, maxNodes: limites.maxNodes });
  }
  return AppError.badRequest(`${onde} tem um número fora da faixa aceita.`, 'REQUEST_BODY_NUMBER_OUT_OF_RANGE', { fields, part: parte });
}

/** Middleware global: `app.use(rejectOversizedShape)` depois dos leitores do corpo e antes das rotas. */
function rejectOversizedShape(req, _res, next) {
  const limites = limitesDaForma();
  for (const parte of ['body', 'query']) {
    const achado = inspecionarForma(req[parte], limites);
    if (achado) return next(erroDaForma(achado, parte, limites));
  }
  return next();
}

module.exports = { rejectOversizedShape, inspecionarForma, limitesDaForma, PADRAO, FAIXA };
