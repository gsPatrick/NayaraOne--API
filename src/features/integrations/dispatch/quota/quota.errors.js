'use strict';

const AppError = require('../../../../utils/AppError');

/** Operação sem fila (quem chama espera a resposta) e sem cota: 429 com o instante em que volta (M9-D218 seção 4). */
const quotaExhausted = (retryAt) => new AppError('Cota do fornecedor esgotada; a operação foi reagendada.', 429, 'INTEGRATION_QUOTA_EXHAUSTED', retryAt ? { retryAt: new Date(retryAt).toISOString() } : undefined);

module.exports = { quotaExhausted };
