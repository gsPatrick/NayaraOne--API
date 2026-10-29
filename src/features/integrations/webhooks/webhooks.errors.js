'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da rota pública de webhooks (M9-D211 4). Mensagens genéricas: quem não prova a assinatura não descobre o que existe. */
const signatureInvalid = () => AppError.unauthorized('Assinatura inválida.', 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
const unknownChannel = () => AppError.notFound('Canal de webhook desconhecido.', 'INTEGRATION_WEBHOOK_UNKNOWN_CHANNEL');
const noVerifier = () => new AppError('Este fornecedor não tem verificador de assinatura.', 501, 'INTEGRATION_WEBHOOK_NO_VERIFIER');
const tooLarge = () => new AppError('Corpo do webhook maior que o limite permitido.', 413, 'INTEGRATION_WEBHOOK_TOO_LARGE');
const rateLimited = (retryAfterS) => new AppError('Muitas chamadas; tente novamente em instantes.', 429, 'INTEGRATION_RATE_LIMITED', { retryAfterS });
const rateUnavailable = () => new AppError('Não foi possível conferir o limite de chamadas; tente novamente em instantes.', 503, 'INTEGRATION_RATE_LIMIT_UNAVAILABLE');

module.exports = { signatureInvalid, unknownChannel, noVerifier, tooLarge, rateLimited, rateUnavailable };
