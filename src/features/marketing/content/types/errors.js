'use strict';

const { mktError } = require('../../marketing.errors');

/** Erros dos 10 tipos de conteúdo (M9-D409). Mensagens em português; o detalhe técnico vai em details. */
const typeInvalid = (details) => mktError(400, 'MKT_CONTENT_TYPE_INVALID', 'Tipo de conteúdo inválido.', details);
const requiredField = (details) => mktError(422, 'MKT_CONTENT_REQUIRED_FIELD', 'Faltam campos obrigatórios para este tipo de conteúdo.', details);
const channelNotAllowed = (details) => mktError(422, 'MKT_CONTENT_CHANNEL_NOT_ALLOWED', 'Este tipo de conteúdo não pode ser publicado neste canal.', details);

const sourceNotEligible = (details) => mktError(422, 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE', 'A fonte informada não está apta para este tipo de conteúdo.', details);

module.exports = { typeInvalid, requiredField, channelNotAllowed, sourceNotEligible };
