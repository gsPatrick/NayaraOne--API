'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /feature-flags` (rodada 8 da verificação do Marco 9, DI-M9R-24): `kind` como objeto (ou um texto fora da lista) virava o nome
 * `undefined` da tabela no SQL (42P01, 500). `kind` é FLAG ou CONFIG (sem diferença de maiúsculas, como o serviço lê); `owner` e `id`, UUID em
 * texto; o resto, texto. Recusa com o código do módulo (422 GOV_FLAG_INPUT_INVALID).
 */
const UUID = `^(?:|${V.UUID_PATTERN.slice(1, -1)})$`;
const LISTAR = V.objetoAberto({
  kind: V.textoDaConsulta({ max: 6, padrao: '^(?:[Ff][Ll][Aa][Gg]|[Cc][Oo][Nn][Ff][Ii][Gg]|)$', descricao: 'FLAG ou CONFIG' }),
  scope: V.textoDaConsulta({ max: 20 }),
  risk: V.textoDaConsulta({ max: 20 }),
  state: V.textoDaConsulta({ max: 20 }),
  owner: V.textoDaConsulta({ max: 36, padrao: UUID, descricao: 'um identificador (UUID) em texto' }),
  id: V.textoDaConsulta({ max: 36, padrao: UUID, descricao: 'um identificador (UUID) em texto' }),
  key: V.textoDaConsulta({ max: 200 }),
});

module.exports = { validarListagemDeFlags: V.validarEntrada({ query: LISTAR }, 'GOV_FLAG_INPUT_INVALID', { status: 422 }), ESQUEMAS: { LISTAR } };
