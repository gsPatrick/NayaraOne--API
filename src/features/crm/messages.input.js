'use strict';

const AppError = require('../../utils/AppError');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message) => AppError.badRequest(message, 'MESSAGE_VALIDATION');

/**
 * Tipo dos campos de referência das rotas de mensagem (verificação independente do Marco 9, rodada 4, 12/11/2026; DI-M9R-8).
 * O corpo chega do JSON como veio: um `{ "id": ... }` ou uma lista em `conversationId`, `mediaQuarantineId`, `personId` ou `opportunityId`
 * ia direto para o `findOne`/`findByPk` e virava 500 (`Invalid value`, `Argument passed to findByPk is invalid`). Agora a forma é conferida
 * ANTES de qualquer consulta: vazio (ausente, null ou "") é "sem vínculo"; qualquer outra coisa que não seja um UUID em texto é 400
 * `MESSAGE_VALIDATION`, o código de validação das rotas de mensagem, com o nome do campo. Nenhuma consulta é feita com valor fora da forma.
 */
function idOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`O campo "${field}" deve ser um identificador (UUID) em texto.`);
  return value;
}

/** Texto opcional com limite da coluna (ex.: `externalMessageId` varchar(128), `actionKey` varchar(64)): lista, objeto, número ou texto longo demais é 400. */
function textOrNull(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid(`O campo "${field}" deve ser um texto.`);
  if (max && value.length > max) throw invalid(`O campo "${field}" aceita no máximo ${max} caracteres.`);
  return value;
}

module.exports = { idOrNull, textOrNull, UUID };
