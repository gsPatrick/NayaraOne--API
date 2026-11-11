'use strict';

const AppError = require('../../../utils/AppError');

/** Erros do cofre de segredos (M9-D202). Nenhuma mensagem carrega valor, caminho do cofre ou endereço. */

const secretNotFound = () => AppError.notFound('Referência de segredo não encontrada no cofre.', 'INTEGRATION_SECRET_NOT_FOUND');

const storeUnavailable = () => new AppError('Cofre de segredos indisponível; a operação foi adiada.', 503, 'INTEGRATION_SECRET_STORE_UNAVAILABLE');

const rotationFailed = () => AppError.unprocessable('A nova credencial não passou no teste; a anterior continua em uso.', 'INTEGRATION_SECRET_ROTATION_FAILED');

const driverForbidden = () => AppError.internal('Cofre local não é permitido para integração bancária em produção.', 'INTEGRATION_SECRET_DRIVER_FORBIDDEN');

const storeNotConfigured = (dica) => AppError.internal(`Cofre de segredos não configurado.${dica ? ` ${dica}` : ''}`, 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED');

const storeConfig = (motivo) => AppError.internal(`Cofre de segredos com configuração inválida: ${motivo}`, 'INTEGRATION_SECRET_STORE_CONFIG');

const refInvalid = (motivo) => AppError.unprocessable(motivo || 'Referência do cofre em formato inválido. Use letras minúsculas, números, "/", "-" e "_" (de 6 a 159 caracteres).', 'INTEGRATION_SECRET_REF_INVALID');

const refForeignCompany = () => AppError.unprocessable('A referência do cofre pertence a outra empresa.', 'INTEGRATION_SECRET_REF_FOREIGN_COMPANY');

const refShared = () => AppError.conflict('Esta referência do cofre já está em uso por outra integração desta empresa.', 'INTEGRATION_SECRET_REF_SHARED');

const bankWorkerOnly = () => AppError.forbidden('A credencial bancária só é lida pelo processamento de envio, não por requisição de usuário.', 'INTEGRATION_SECRET_BANK_WORKER_ONLY');

const secretExpired = () => AppError.conflict('A credencial desta integração venceu; renove o segredo no cofre.', 'INTEGRATION_SECRET_EXPIRED');

module.exports = {
  secretNotFound, storeUnavailable, rotationFailed, driverForbidden, storeNotConfigured, storeConfig,
  refInvalid, refForeignCompany, refShared, bankWorkerOnly, secretExpired,
};
