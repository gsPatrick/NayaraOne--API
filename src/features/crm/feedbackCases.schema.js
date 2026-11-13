'use strict';

const V = require('../../shared/validation/requestSchema');

/**
 * Consulta de `GET /crm/feedback-cases` (rodada 8 da verificação do Marco 9, DI-M9R-24): `type[toString]=x` virava objeto e o `String()` do
 * serviço lançava (500). Os filtros são texto; os identificadores, UUID em texto; `overdue`, "true" ou "false".
 */
const LISTAR = V.objetoAberto({
  status: V.textoDaConsulta({ max: 30 }),
  type: V.textoDaConsulta({ max: 30 }),
  severity: V.textoDaConsulta({ max: 30 }),
  personId: V.textoDaConsulta({ max: 36, padrao: `^(?:|${V.UUID_PATTERN.slice(1, -1)})$`, descricao: 'um identificador (UUID) em texto' }),
  assignedToUserId: V.textoDaConsulta({ max: 36, padrao: `^(?:|${V.UUID_PATTERN.slice(1, -1)})$`, descricao: 'um identificador (UUID) em texto' }),
  overdue: V.textoDaConsulta({ max: 5, valores: ['true', 'false', ''] }),
});

module.exports = { validarListagemDeCasos: V.validarEntrada({ query: LISTAR }, 'FEEDBACK_CASE_VALIDATION'), ESQUEMAS: { LISTAR } };
