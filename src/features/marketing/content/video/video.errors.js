'use strict';

const { mktError } = require('../../marketing.errors');

/** Erros do vídeo e da mídia do Marketing (M9-D426 §4): código MKT_ e mensagem em português, sem detalhe técnico do fornecedor. */
const mediaNotAuthorized = (details) => mktError(422, 'MKT_MEDIA_NOT_AUTHORIZED', 'A mídia não está autorizada para marketing.', details);
const materialAlteration = (details) => mktError(422, 'MKT_MEDIA_MATERIAL_ALTERATION', 'Esta alteração mudaria o imóvel de forma enganosa.', details);
const syntheticDisclosureRequired = (details) => mktError(422, 'MKT_SYNTHETIC_DISCLOSURE_REQUIRED', 'Conteúdo sintético exige aviso de transparência.', details);
const videoInvalid = (message, details) => mktError(400, 'MKT_VALIDATION', message, details);
const mediaNotFound = () => mktError(404, 'MKT_NOT_FOUND', 'Arquivo não encontrado.');

module.exports = { mediaNotAuthorized, materialAlteration, syntheticDisclosureRequired, videoInvalid, mediaNotFound };
