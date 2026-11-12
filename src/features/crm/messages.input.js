'use strict';

const AppError = require('../../utils/AppError');
const { UUID, ACTION_KEY } = require('./messages.constants');

const invalid = (message) => AppError.badRequest(message, 'MESSAGE_VALIDATION');
const vazio = (value) => value === undefined || value === null || value === '';

/**
 * Tipo dos campos de referência das rotas de mensagem (verificação independente do Marco 9, rodada 4, 12/11/2026; DI-M9R-8).
 * O corpo chega do JSON como veio: um `{ "id": ... }` ou uma lista em `conversationId`, `mediaQuarantineId`, `personId` ou `opportunityId`
 * ia direto para o `findOne`/`findByPk` e virava 500 (`Invalid value`, `Argument passed to findByPk is invalid`). Agora a forma é conferida
 * ANTES de qualquer consulta: vazio (ausente, null ou "") é "sem vínculo"; qualquer outra coisa que não seja um UUID em texto é 400
 * `MESSAGE_VALIDATION`, o código de validação das rotas de mensagem, com o nome do campo. Nenhuma consulta é feita com valor fora da forma.
 * Na rota HTTP o esquema da rota (messages.schema.js, DI-M9R-11) já recusou a forma errada; estas conferências valem para os chamadores internos.
 */
function idOrNull(value, field) {
  if (vazio(value)) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`O campo "${field}" deve ser um identificador (UUID) em texto.`);
  return value;
}

/** Texto opcional com limite da coluna (ex.: `externalMessageId` varchar(128)): lista, objeto, número ou texto longo demais é 400. */
function textOrNull(value, field, max) {
  if (vazio(value)) return null;
  if (typeof value !== 'string') throw invalid(`O campo "${field}" deve ser um texto.`);
  if (max && value.length > max) throw invalid(`O campo "${field}" aceita no máximo ${max} caracteres.`);
  return value;
}

/**
 * Valor de lista fechada, em texto (maiúsculas ou minúsculas), devolvido em maiúsculas. Rodada 5 (DI-M9R-11): o `String(valor)` de antes lançava
 * TypeError com `{"toString": 1}` (500) e transformava `{}` em "[OBJECT OBJECT]"; agora só texto chega ao `toUpperCase`. Vazio devolve `fallback`.
 */
function oneOf(value, field, list, fallback = null) {
  if (vazio(value)) return fallback;
  if (typeof value !== 'string' || !list.includes(value.toUpperCase())) throw invalid(`O campo "${field}" deve ser um de: ${list.join(', ')}.`);
  return value.toUpperCase();
}

/** Chave de idempotência da automação (M9-D415): sha256 em hexadecimal minúsculo, o formato da CHECK da migration 755 (outro texto ia ao banco e dava 500). */
function actionKeyOrNull(value) {
  if (vazio(value)) return null;
  if (typeof value !== 'string' || !ACTION_KEY.test(value)) throw invalid('O campo "actionKey" deve ser um sha256 em hexadecimal minúsculo (64 caracteres de 0-9 e a-f).');
  return value;
}

module.exports = { idOrNull, textOrNull, oneOf, actionKeyOrNull, UUID };
