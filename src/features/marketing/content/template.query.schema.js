'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /marketing/templates` (rodada 8 da verificação do Marco 9, DI-M9R-24): a página finita enorme passava por `Number.isInteger` e o
 * OFFSET ia ao banco como `infinity` (500). `page` e `pageSize` são inteiros em texto (só dígitos); os filtros, texto. Recusa com o código do
 * módulo (400 VALIDATION_ERROR, o mesmo de parseListFilters).
 */
const LISTAR = V.objetoAberto({
  code: V.textoDaConsulta({ max: 120 }),
  status: V.textoDaConsulta({ max: 30 }),
  channel: V.textoDaConsulta({ max: 30 }),
  page: V.inteiroDaConsulta(),
  pageSize: V.inteiroDaConsulta(),
});

module.exports = { validarListagemDeTemplates: V.validarEntrada({ query: LISTAR }, 'VALIDATION_ERROR'), ESQUEMAS: { LISTAR } };
