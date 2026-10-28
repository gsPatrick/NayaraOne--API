'use strict';

const AppError = require('../../../utils/AppError');

const invalidTransition = (de, para) => AppError.conflict(`Transição de estado inválida: ${de} -> ${para}.`, 'INTEGRATION_DISPATCH_INVALID_TRANSITION');
const immutable = () => AppError.conflict('O conteúdo aprovado de um envio não pode ser alterado.', 'INTEGRATION_DISPATCH_IMMUTABLE');
const keyRequired = () => AppError.unprocessable('Informe a chave de idempotência da operação.', 'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED');

/** Traduz a recusa do gatilho de imutabilidade do banco para o erro de negócio (409). */
function translateDispatchDbError(err) {
  const msg = String((err && (err.parent?.message || err.message)) || '');
  return msg.includes('INTEGRATION_DISPATCH_IMMUTABLE') ? immutable() : err;
}

module.exports = { invalidTransition, immutable, keyRequired, translateDispatchDbError };
