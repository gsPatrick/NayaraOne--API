'use strict';

const AppError = require('../../utils/AppError');

/**
 * Contrato da CONSULTA (query string) de toda rota (rodada 8 da verificação do Marco 9, 12/11/2026; DI-M9R-24).
 *
 * O leitor de consulta do Express (`qs`) transforma `a[b]=1` em objeto e `a=1&a=2` ou `a[]=1` em lista. Nenhuma porta conferia a forma desses
 * valores, e os serviços liam a consulta como texto: `String({ toString: 'x' })` lança (`GET /people`, `GET /crm/feedback-cases`), um objeto virava
 * nome de tabela (`GET /feature-flags`), uma lista virava `IN (...)` no lugar de `=` (`GET /ai/release-gates`), e `page=1.7976931348623157e308`
 * (um número FINITO) fazia o `OFFSET` ir ao banco como `infinity` (`/ai/memories`, `/ai/recommendations`, `/marketing/publications`,
 * `/marketing/templates`). O contrato, igual para todas as rotas:
 * 1. FORMA: cada valor é um texto. Lista de textos só nos parâmetros que a rota declara como lista (`declararConsulta({ listas })`, ou o tipo
 *    `array` no esquema de consulta da rota); objeto nunca. Resposta: 400 `QUERY_PARAMETER_INVALID`.
 * 2. PAGINAÇÃO, num ponto único para todas as listas: `page`, `offset` e `skip` (posição) e `limit`, `pageSize`, `perPage`, `per_page` e `take`
 *    (tamanho) são um valor só; quando o texto é um número (o que `Number()` dos serviços leria como número), tem de ser um inteiro decimal de 0 até
 *    `QUERY_POSITION_MAX` (padrão 100.000.000) ou `QUERY_SIZE_MAX` (padrão 100.000). Assim `(page - 1) * limit` é sempre um inteiro exato, longe de
 *    `Infinity`. Resposta: 400 `QUERY_PAGINATION_INVALID`. Texto que não é número (`page=abc`) segue para a rota, que tem a regra e o código próprios
 *    (por exemplo o 422 da M9-D249 e o 400 do BI): o contrato é o piso comum, não substitui a validação do módulo.
 * As faixas da regra 2 são do servidor (variáveis de ambiente), como os limites da forma do corpo (DI-M9R-18): valem antes de se saber quem pede.
 * Mensagem com o nome do parâmetro (cortado em 64), `details.fields` e `details.problems` no formato da tela; nunca o valor recebido.
 */
const POSICAO = Object.freeze(['page', 'offset', 'skip']);
const TAMANHO = Object.freeze(['limit', 'pageSize', 'perPage', 'per_page', 'take']);
const PADRAO = Object.freeze({ positionMax: 100000000, sizeMax: 100000 });
const FAIXA = Object.freeze({ positionMax: [1000, 1000000000000], sizeMax: [100, 10000000] });

function inteiroDoAmbiente(valor, padrao, [min, max]) {
  const n = Number(valor);
  if (valor === undefined || valor === '' || !Number.isInteger(n) || n < min || n > max) return padrao;
  return n;
}

/** Faixas em vigor (lidas a cada pedido). */
function limitesDaPaginacao(env = process.env) {
  return {
    positionMax: inteiroDoAmbiente(env.QUERY_POSITION_MAX, PADRAO.positionMax, FAIXA.positionMax),
    sizeMax: inteiroDoAmbiente(env.QUERY_SIZE_MAX, PADRAO.sizeMax, FAIXA.sizeMax),
  };
}

const nomeVisivel = (nome) => {
  const texto = String(nome).toWellFormed().split('\u0000').join('�');
  return texto.length > 64 ? `${texto.slice(0, 64)}…` : texto;
};

function erro(codigo, nome, mensagem) {
  const campo = nomeVisivel(nome);
  const texto = mensagem(campo);
  return AppError.badRequest(texto, codigo, { fields: [campo], problems: [{ field: campo, message: texto }], part: 'query' });
}

/** Texto que o `Number()` de um serviço leria como número (inclusive `Infinity`, `1e308`, `0x10`, `-5`, `2.5`). */
const pareceNumero = (texto) => texto.trim() !== '' && !Number.isNaN(Number(texto));

/** Primeiro problema da consulta pelo contrato, como AppError, ou null. `listas`: parâmetros que a rota aceita como lista de textos. */
function conferirConsulta(query, { listas = [] } = {}, limites = limitesDaPaginacao()) {
  if (!query || typeof query !== 'object') return null;
  for (const nome of Object.keys(query)) {
    const valor = query[nome];
    if (typeof valor === 'string') continue;
    const ehPaginacao = POSICAO.includes(nome) || TAMANHO.includes(nome);
    if (Array.isArray(valor) && !ehPaginacao && listas.includes(nome) && valor.every((v) => typeof v === 'string')) continue;
    if (Array.isArray(valor) && !listas.includes(nome)) return erro('QUERY_PARAMETER_INVALID', nome, (c) => `O parâmetro "${c}" da consulta aceita um valor só (veio repetido ou como lista).`);
    return erro('QUERY_PARAMETER_INVALID', nome, (c) => `O parâmetro "${c}" da consulta deve ser ${listas.includes(nome) ? 'um texto ou uma lista de textos' : 'um texto'}.`);
  }
  for (const [nomes, max] of [[POSICAO, limites.positionMax], [TAMANHO, limites.sizeMax]]) {
    for (const nome of nomes) {
      const valor = query[nome];
      if (typeof valor !== 'string' || !pareceNumero(valor)) continue;
      const texto = valor.trim();
      if (/^\d{1,15}$/.test(texto) && Number(texto) <= max) continue;
      return erro('QUERY_PAGINATION_INVALID', nome, (c) => `O parâmetro "${c}" da consulta deve ser um número inteiro de 0 a ${max}.`);
    }
  }
  return null;
}

/**
 * Declaração da consulta na rota: `router.get('/x', requirePermission(...), declararConsulta({ listas: ['status'] }), controller)`. Não faz nada no
 * pedido; o contrato (queryContract.apply.js) lê a declaração ao montar as rotas.
 */
function declararConsulta({ listas = [] } = {}) {
  const marcador = (_req, _res, next) => next();
  marcador.listasDaConsulta = Object.freeze([...listas]);
  return marcador;
}

module.exports = { conferirConsulta, declararConsulta, limitesDaPaginacao, POSICAO, TAMANHO, PADRAO, FAIXA };
