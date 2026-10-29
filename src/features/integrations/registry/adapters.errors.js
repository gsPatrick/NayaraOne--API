'use strict';

const AppError = require('../../../utils/AppError');

const contractInvalid = (problemas, code) => AppError.internal('Adaptador não cumpre o contrato da integração.', 'INTEGRATION_ADAPTER_CONTRACT_INVALID', { providerCode: code || null, problemas });
const versionUnsupported = (version, suportadas) => AppError.unprocessable('Versão da API do fornecedor não suportada.', 'INTEGRATION_VERSION_UNSUPPORTED', { versao: version, suportadas });

module.exports = {
  notImplemented: () => new AppError('Este fornecedor ainda não tem adaptador instalado.', 501, 'INTEGRATION_ADAPTER_NOT_IMPLEMENTED'),
  contractInvalid,
  versionUnsupported,
  statusUnmapped: () => new AppError('Status devolvido pelo fornecedor não é reconhecido.', 502, 'INTEGRATION_STATUS_UNMAPPED'),
  requestInvalid: (op, problemas) => AppError.unprocessable(`Pedido inválido para a operação ${op}.`, 'INTEGRATION_REQUEST_INVALID', { problemas }),
  responseInvalid: (op, problemas) => new AppError(`Resposta do fornecedor inválida na operação ${op}.`, 502, 'INTEGRATION_RESPONSE_INVALID', { problemas }),
};
