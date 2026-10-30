'use strict';

const { mktError } = require('../../../marketing.errors');

/** Erros do envio de mensagem do Marketing (M9-D429 seção 4): código MKT_ e mensagem em português, nunca detalhe do provedor. */
const templateNotApproved = (details) => mktError(422, 'MKT_TEMPLATE_NOT_APPROVED', 'Este canal exige template oficial aprovado.', details);
const unsubscribeRequired = (details) => mktError(422, 'MKT_UNSUBSCRIBE_REQUIRED', 'E-mail de marketing exige link de descadastro.', details);
const invalidMessage = (message, details) => mktError(422, 'MKT_VALIDATION', message, details);
const unknownTemplateVariable = (names) => mktError(422, 'MKT_TEMPLATE_UNKNOWN_VARIABLE', 'O template usa uma variável sem valor.', { variables: names });

module.exports = { templateNotApproved, unsubscribeRequired, invalidMessage, unknownTemplateVariable };
