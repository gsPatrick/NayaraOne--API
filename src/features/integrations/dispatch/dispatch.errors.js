'use strict';

const AppError = require('../../../utils/AppError');

const invalidTransition = (de, para) => AppError.conflict(`Transição de estado inválida: ${de} -> ${para}.`, 'INTEGRATION_DISPATCH_INVALID_TRANSITION');
const immutable = () => AppError.conflict('O conteúdo aprovado de um envio não pode ser alterado.', 'INTEGRATION_DISPATCH_IMMUTABLE');
const retryNotAllowed = () => AppError.conflict('Este erro é permanente: corrija os dados e envie novamente.', 'INTEGRATION_RETRY_NOT_ALLOWED');
const authFailed = () => new AppError('O fornecedor recusou a credencial; a integração foi pausada.', 502, 'INTEGRATION_AUTH_FAILED');
const keyRequired = () => AppError.unprocessable('Informe a chave de idempotência da operação.', 'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED');

/** Traduz a recusa do gatilho de imutabilidade do banco para o erro de negócio (409). */
function translateDispatchDbError(err) {
  const msg = String((err && (err.parent?.message || err.message)) || '');
  return msg.includes('INTEGRATION_DISPATCH_IMMUTABLE') ? immutable() : err;
}

module.exports = { invalidTransition, immutable, keyRequired, retryNotAllowed, authFailed, translateDispatchDbError };
