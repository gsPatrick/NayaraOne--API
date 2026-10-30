'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da quarentena (M9-D247 seção 4). */
module.exports = {
  quarantined: () => new AppError('O arquivo ainda está em verificação de segurança.', 423, 'INTEGRATION_FILE_QUARANTINED'),
  infected: () => AppError.unprocessable('O arquivo foi bloqueado pela verificação de segurança.', 'INTEGRATION_FILE_INFECTED'),
  rejected: (status) => AppError.unprocessable('O arquivo foi bloqueado pela verificação de segurança.', 'INTEGRATION_FILE_REJECTED', { status }),
  notFound: () => AppError.notFound('Arquivo em verificação não encontrado.', 'INTEGRATION_FILE_QUARANTINE_NOT_FOUND'),
};
