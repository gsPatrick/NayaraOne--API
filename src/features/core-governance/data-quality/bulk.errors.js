'use strict';

const { govError, govNotFound } = require('../governance.errors');

/** Erros da alteração em massa (M9-D808 §4). Os de Idempotency-Key seguem o texto do padrão de API (M9-D843 §3.3). Códigos novos levam GOV_. */
const filterInvalid = (details) => govError(400, 'GOV_BULK_FILTER_INVALID', 'Filtro inválido.', details);
const tooLarge = (details) => govError(422, 'GOV_BULK_TOO_LARGE', 'O lote excede o limite de registros.', details);
const validation = (message, details) => govError(400, 'VALIDATION_ERROR', message, details);
const idempotencyRequired = () => govError(400, 'GOV_IDEMPOTENCY_KEY_REQUIRED', 'Envie o cabeçalho Idempotency-Key.');
const idempotencyReused = () => govError(422, 'GOV_IDEMPOTENCY_KEY_REUSED', 'Esta chave de idempotência já foi usada com outra requisição.');
const failed = () => govError(500, 'INTERNAL_ERROR', 'Não foi possível aplicar o lote; nada foi alterado.');
const notFound = () => govNotFound();

module.exports = { filterInvalid, tooLarge, validation, idempotencyRequired, idempotencyReused, failed, notFound };
