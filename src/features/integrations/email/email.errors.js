'use strict';

const AppError = require('../../../utils/AppError');

/** Erros do e-mail de saída (M9-D234 4): código estável e mensagem em português do livro. */
module.exports = {
  classificationBlocked: (fileId, reason) => AppError.forbidden('Este documento não pode ser enviado como anexo; use o link seguro.', 'INTEGRATION_EMAIL_ATTACHMENT_CLASSIFICATION_BLOCKED', { fileId, reason }),
  notClean: (fileId) => AppError.unprocessable('O anexo ainda não foi liberado pela verificação de segurança.', 'INTEGRATION_EMAIL_ATTACHMENT_NOT_CLEAN', { fileId }),
  tooLarge: (totalBytes, maxBytes) => new AppError('Os anexos excedem o tamanho máximo permitido.', 413, 'INTEGRATION_EMAIL_ATTACHMENT_TOO_LARGE', { totalBytes, maxBytes }),
  typeNotAllowed: (fileId, extension) => AppError.unprocessable('O tipo de arquivo não é aceito como anexo de e-mail.', 'INTEGRATION_EMAIL_ATTACHMENT_TYPE_NOT_ALLOWED', { fileId, extension }),
  notAuthorized: (fileId) => AppError.forbidden('Você não tem autorização sobre este arquivo para enviá-lo como anexo.', 'INTEGRATION_EMAIL_ATTACHMENT_NOT_AUTHORIZED', { fileId }),
  notFound: (fileId) => AppError.notFound('Anexo não encontrado.', 'INTEGRATION_EMAIL_ATTACHMENT_NOT_FOUND', { fileId }),
  tooManyAttachments: (max) => AppError.unprocessable(`A mensagem pode ter no máximo ${max} anexo(s).`, 'INTEGRATION_EMAIL_TOO_MANY_ATTACHMENTS', { max }),
  recipientInvalid: (address) => AppError.unprocessable('Há um endereço de e-mail inválido entre os destinatários.', 'INTEGRATION_EMAIL_RECIPIENT_INVALID', { address }),
  noRecipient: () => AppError.unprocessable('Informe ao menos um destinatário.', 'INTEGRATION_EMAIL_RECIPIENT_REQUIRED'),
  tooManyRecipients: (max) => AppError.unprocessable(`A mensagem pode ter no máximo ${max} destinatário(s).`, 'INTEGRATION_EMAIL_TOO_MANY_RECIPIENTS', { max }),
  contentRequired: () => AppError.unprocessable('Informe o assunto e o texto da mensagem.', 'INTEGRATION_EMAIL_CONTENT_REQUIRED'),
};
