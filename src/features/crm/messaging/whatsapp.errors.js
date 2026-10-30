'use strict';

const AppError = require('../../../utils/AppError');

/** Erros do WhatsApp (M9-D230 seção 4): código estável e a mensagem em português do livro. */
module.exports = {
  outsideWindow: (windowH) => AppError.unprocessable('Fora da janela de 24 horas: use um modelo aprovado.', 'INTEGRATION_MESSAGING_OUTSIDE_SESSION_WINDOW', { windowH }),
  noConsent: (purpose) => AppError.forbidden('O contato não autorizou receber mensagens por este canal.', 'INTEGRATION_MESSAGING_NO_CONSENT', { purpose }),
  variablesMismatch: (esperadas, recebidas) => AppError.unprocessable('O número de variáveis não confere com o modelo.', 'INTEGRATION_MESSAGING_TEMPLATE_VARIABLES_MISMATCH', { esperadas, recebidas }),
  templateNotApproved: (name) => AppError.unprocessable('O modelo não está aprovado no fornecedor: escolha um modelo aprovado.', 'INTEGRATION_MESSAGING_TEMPLATE_NOT_APPROVED', { name }),
  mediaNotClean: (fileId) => AppError.unprocessable('O arquivo ainda não foi liberado pela verificação de segurança.', 'INTEGRATION_MESSAGING_MEDIA_NOT_CLEAN', { fileId }),
  mediaTooLarge: (bytes, max) => new AppError('O arquivo excede o limite do canal.', 413, 'INTEGRATION_MESSAGING_MEDIA_TOO_LARGE', { bytes, max }),
  mediaNotFound: (fileId) => AppError.notFound('Arquivo da mídia não encontrado.', 'INTEGRATION_MESSAGING_MEDIA_NOT_FOUND', { fileId }),
  mediaNotAuthorized: (fileId) => AppError.forbidden('Você não tem autorização sobre este arquivo para enviá-lo.', 'INTEGRATION_MESSAGING_MEDIA_NOT_AUTHORIZED', { fileId }),
  mediaClassification: (fileId, reason) => AppError.forbidden('A classificação deste arquivo não permite enviá-lo por este canal.', 'INTEGRATION_MESSAGING_MEDIA_CLASSIFICATION_BLOCKED', { fileId, reason }),
  mediaType: (fileId, mime) => AppError.unprocessable('O tipo de arquivo não é aceito pelo canal.', 'INTEGRATION_MESSAGING_MEDIA_TYPE_NOT_ALLOWED', { fileId, mime }),
};
