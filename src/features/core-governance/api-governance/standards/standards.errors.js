'use strict';

const { govError } = require('../../governance.errors');

/** Erros dos padrões de API (M9-D843 §4). */
const rateLimited = (retryAfter) => govError(429, 'GOV_RATE_LIMITED', `Muitas requisições. Tente novamente em ${retryAfter} segundos.`, { retryAfter });
const paginationInvalid = (details) => govError(400, 'GOV_VALIDATION_PAGINATION', 'Parâmetros de paginação inválidos.', details);
const keyReused = () => govError(422, 'GOV_IDEMPOTENCY_KEY_REUSED', 'Esta chave de idempotência já foi usada com outra requisição.');
const keyRequired = () => govError(400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.');
const keyInvalid = () => govError(400, 'GOV_IDEMPOTENCY_KEY_INVALID', 'A chave de idempotência deve ter de 8 a 128 caracteres.');
const responsePending = () => govError(409, 'GOV_IDEMPOTENCY_RESPONSE_PENDING', 'A requisição original ainda está em andamento ou não guardou a resposta. Tente de novo em instantes.');

module.exports = { rateLimited, paginationInvalid, keyReused, keyRequired, keyInvalid, responsePending };
