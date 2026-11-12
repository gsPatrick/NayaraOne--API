'use strict';

const AppError = require('../../../../utils/AppError');

const notApplicable = (message) => AppError.conflict(message, 'INTEGRATION_MESSAGING_ALTERNATE_NOT_APPLICABLE');

/** Erros do canal alternativo do WhatsApp (M9-D227). Só mensagem em português e código, sem dado do contato. */
module.exports = {
  // Mensagem que não existe no escopo de quem chama (id inexistente ou de outra empresa): 404 com o mesmo código das outras rotas de mensagem, nunca o 409 de "não se aplica".
  notFound: () => AppError.notFound('Mensagem não encontrada.', 'MESSAGE_NOT_FOUND'),
  noConsent: () => AppError.conflict('O contato não autorizou o canal alternativo.', 'INTEGRATION_MESSAGING_NO_CONSENT_ALTERNATE'),
  noAddress: () => AppError.conflict('O contato não tem endereço no canal alternativo.', 'INTEGRATION_MESSAGING_NO_ALTERNATE_ADDRESS'),
  notQueued: () => notApplicable('Só a mensagem de texto que está na fila do WhatsApp pode seguir pelo canal alternativo.'),
  marketing: () => notApplicable('Mensagem de marketing não usa o canal alternativo: ela aguarda na fila.'),
  notInContingency: () => notApplicable('O canal alternativo só vale enquanto a contingência do WhatsApp está ativa.'),
};
