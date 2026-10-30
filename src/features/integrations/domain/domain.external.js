'use strict';

const AppError = require('../../../utils/AppError');

const CODES = new Set(['INTEGRATION_RESPONSE_INVALID', 'INTEGRATION_STATUS_UNMAPPED', 'INTEGRATION_RESPONSE_MALFORMED']);

/**
 * Anticorrupção na entrada síncrona (M9-D220 3.1 item 1 e seção 4): resposta do fornecedor fora do formato esperado vira 502 `INTEGRATION_EXTERNAL_DATA_REJECTED` e NADA do que veio
 * entra no domínio. Quem chama o fornecedor a pedido do usuário (consulta de status, download) executa a chamada por aqui e só depois grava.
 */
async function guardExternalData(call) {
  try {
    return await call();
  } catch (err) {
    if (err && (CODES.has(err.code) || err instanceof SyntaxError)) {
      throw new AppError('O fornecedor devolveu dados fora do formato esperado; nada foi alterado.', 502, 'INTEGRATION_EXTERNAL_DATA_REJECTED');
    }
    throw err;
  }
}

module.exports = { guardExternalData };
