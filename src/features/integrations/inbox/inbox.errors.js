'use strict';

const AppError = require('../../../utils/AppError');

const eventIdMissing = () => AppError.badRequest('Evento sem identificador externo.', 'INTEGRATION_WEBHOOK_EVENT_ID_MISSING');
const unknownChannel = () => AppError.notFound('Canal de webhook desconhecido.', 'INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL');
const invalidTransition = (de, para) => AppError.internal(`Transição de estado inválida na caixa de entrada: ${de} -> ${para}.`, 'INTEGRATION_INBOX_INVALID_TRANSITION');

module.exports = { eventIdMissing, unknownChannel, invalidTransition };
