'use strict';

const { govError, govNotFound } = require('../../governance.errors');

/** Erros dos links externos (M9-D823 §4). Mensagens em português, as do livro/da demanda. */
const expiryTooLong = (hours) => govError(422, 'GOV_LINK_EXPIRY_TOO_LONG', `O prazo máximo para esta classificação é de ${hours} horas.`, { maxHours: hours });
const notOwner = () => govError(403, 'GOV_LINK_NOT_OWNER', 'Você não pode revogar este link.');
const alreadyFinal = () => govError(409, 'GOV_LINK_ALREADY_FINAL', 'Este link já foi encerrado.');
const unavailable = () => govError(404, 'GOV_LINK_UNAVAILABLE', 'Link indisponível.');
const resourceInvalid = () => govError(400, 'GOV_LINK_RESOURCE_INVALID', 'Tipo de recurso inválido para compartilhar.');
const requestInvalid = (message, details) => govError(400, 'GOV_LINK_REQUEST_INVALID', message, details);
const notShareable = () => govError(422, 'GOV_LINK_RESOURCE_NOT_SHAREABLE', 'Este recurso não pode ser compartilhado por link.');
const watermarkUnsupported = () => govError(422, 'GOV_LINK_WATERMARK_UNSUPPORTED', 'Este tipo de arquivo não aceita a marca d\'água exigida para esta classificação.');
const rateLimited = (retryAfter) => govError(429, 'GOV_RATE_LIMITED', 'Muitas requisições. Tente novamente em instantes.', { retryAfter });
const notFound = () => govNotFound('Registro não encontrado.');

module.exports = { expiryTooLong, notOwner, alreadyFinal, unavailable, resourceInvalid, requestInvalid, notShareable, watermarkUnsupported, rateLimited, notFound };
