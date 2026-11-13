'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /ai/memories` (rodada 8 da verificação do Marco 9, DI-M9R-24): `page=1.7976931348623157e308` (finito) fazia o OFFSET ir ao
 * banco como `infinity` (500). `page` e `limit` são inteiros em texto (só dígitos); os filtros, texto.
 */
const LISTAR = V.objetoAberto({
  status: V.textoDaConsulta({ max: 30 }),
  memoryType: V.textoDaConsulta({ max: 60 }),
  subjectType: V.textoDaConsulta({ max: 60 }),
  subjectId: V.textoDaConsulta({ max: 200 }),
  agent: V.textoDaConsulta({ max: 80 }),
  page: V.inteiroDaConsulta(),
  limit: V.inteiroDaConsulta(),
});

module.exports = { validarListagemDeMemorias: V.validarEntrada({ query: LISTAR }, 'AI_MEMORY_INVALID'), ESQUEMAS: { LISTAR } };
