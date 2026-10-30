'use strict';

const AppError = require('../../../utils/AppError');

/** Erros das seguradoras (M9-D238 4): código estável e mensagem em português do livro. */
module.exports = {
  documentRequired: () => AppError.unprocessable('Anexe o documento da apólice para torná-la vigente.', 'INTEGRATION_INSURANCE_POLICY_DOCUMENT_REQUIRED'),
  versionExists: (version) => AppError.conflict('Esta versão da apólice já foi registrada.', 'INTEGRATION_INSURANCE_POLICY_VERSION_EXISTS', { version }),
  versionInvalid: (message) => AppError.unprocessable(message, 'INTEGRATION_INSURANCE_POLICY_VERSION_INVALID'),
  providerFailed: (message, details) => AppError.internal(message || 'A seguradora não concluiu o pedido.', 'PROCUREMENT_INSURANCE_PROVIDER_ERROR', details),
  providerUncertain: () => AppError.conflict('A seguradora não respondeu a tempo: o resultado do pedido é incerto. Confira com a seguradora antes de repetir; o pedido segue com a mesma chave, sem duplicar.', 'INTEGRATION_INSURANCE_RESULT_UNCERTAIN'),
  taskNotFound: () => AppError.notFound('Tarefa da seguradora não encontrada.', 'INTEGRATION_INSURANCE_TASK_NOT_FOUND'),
  taskNotOpen: (status) => AppError.conflict(`Só uma tarefa aberta pode ser concluída ou cancelada (atual: ${status}).`, 'INTEGRATION_INSURANCE_TASK_NOT_OPEN'),
  taskInvalid: (message) => AppError.unprocessable(message, 'INTEGRATION_INSURANCE_TASK_INVALID'),
};
