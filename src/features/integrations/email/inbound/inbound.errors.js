'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do e-mail recebido (M9-D235 seção 4). */
module.exports = {
  piiRestricted: () => AppError.forbidden('Esta mensagem contém dado pessoal e só o perfil autorizado pode abri-la.', 'INTEGRATION_EMAIL_INBOUND_PII_RESTRICTED'),
  notFound: () => AppError.notFound('Mensagem recebida não encontrada.', 'INTEGRATION_EMAIL_INBOUND_NOT_FOUND'),
  linkInvalid: (msg) => AppError.badRequest(msg, 'INTEGRATION_EMAIL_INBOUND_LINK_INVALID'),
  alreadyLinked: () => AppError.conflict('Esta mensagem já está vinculada.', 'INTEGRATION_EMAIL_INBOUND_ALREADY_LINKED'),
};
