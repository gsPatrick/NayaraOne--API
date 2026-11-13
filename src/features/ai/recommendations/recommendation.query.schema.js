'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /ai/recommendations` (rodada 8 da verificação do Marco 9, DI-M9R-24): a página finita enorme fazia o OFFSET ir ao banco como
 * `infinity` (500). `page` e `limit` são inteiros em texto (só dígitos); `status`, texto.
 */
const LISTAR = V.objetoAberto({ status: V.textoDaConsulta({ max: 30 }), page: V.inteiroDaConsulta(), limit: V.inteiroDaConsulta() });

module.exports = { validarListagemDeRecomendacoes: V.validarEntrada({ query: LISTAR }, 'AI_RECOMMENDATION_INVALID'), ESQUEMAS: { LISTAR } };
