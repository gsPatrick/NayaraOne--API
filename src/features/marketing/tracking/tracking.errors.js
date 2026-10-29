'use strict';

const { mktError } = require('../marketing.errors');

/** Erros da atribuição (M9-D431). Mensagens em português. */
const linkNotFound = () => mktError(404, 'MKT_TRACKING_LINK_NOT_FOUND', 'Link de rastreio inválido.');
const evidenceRequired = (details) => mktError(422, 'MKT_ATTRIBUTION_EVIDENCE_REQUIRED', 'O evento de atribuição precisa de evidência.', details);
const modelUnsupported = (details) => mktError(400, 'MKT_ATTRIBUTION_MODEL_UNSUPPORTED', 'Modelo de atribuição não suportado.', details);
const urlNotAllowed = (details) => mktError(422, 'MKT_URL_NOT_ALLOWED', 'A URL informada não é permitida.', details);
const invalidInput = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);
const keyUnavailable = () => mktError(503, 'MKT_TRACKING_KEY_UNAVAILABLE', 'A chave de assinatura dos links está indisponível; tente novamente.');
const notFound = (message) => mktError(404, 'MKT_NOT_FOUND', message);

module.exports = { linkNotFound, evidenceRequired, modelUnsupported, urlNotAllowed, invalidInput, keyUnavailable, notFound };
