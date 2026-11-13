'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /marketing/publications` (rodada 8 da verificação do Marco 9, DI-M9R-24): `page=1.7976931348623157e308` passava por
 * `Number.isInteger` (um número desse tamanho é inteiro para o JavaScript) e o OFFSET ia ao banco como `infinity` (500). `page` e `pageSize` são
 * inteiros em texto (só dígitos); os filtros, texto. Recusa com o código do módulo (400 MKT_VALIDATION).
 */
const LISTAR = V.objetoAberto({
  status: V.textoDaConsulta({ max: 30 }),
  channel: V.textoDaConsulta({ max: 30 }),
  from: V.textoDaConsulta({ max: 64 }),
  to: V.textoDaConsulta({ max: 64 }),
  page: V.inteiroDaConsulta(),
  pageSize: V.inteiroDaConsulta(),
});

module.exports = { validarListagemDePublicacoes: V.validarEntrada({ query: LISTAR }, 'MKT_VALIDATION'), ESQUEMAS: { LISTAR } };
