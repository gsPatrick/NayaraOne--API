'use strict';

const AppError = require('../../../../utils/AppError');

/**
 * Livro §13 "Notificação possui canal, destinatário, conteúdo/arquivo, data e evidência de envio/recebimento": sem
 * destinatário (pessoa do cadastro ou descrição de quem recebe) a notificação não é criada, não ganha versão e não sai.
 */
function assertNoticeRecipient(recipientPersonId, recipientDescription) {
  const description = typeof recipientDescription === 'string' ? recipientDescription.trim() : recipientDescription;
  if (!recipientPersonId && !description) {
    throw AppError.badRequest(
      'Informe o destinatário da notificação: a pessoa do cadastro ("recipientPersonId") ou a descrição de quem recebe ("recipientDescription").',
      'LEGAL_NOTICE_RECIPIENT_REQUIRED'
    );
  }
}

module.exports = { assertNoticeRecipient };
