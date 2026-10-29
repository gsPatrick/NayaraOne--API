'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da regressão da NAY (M9-D033). Código estável, mensagem em português, sem detalhe técnico. */
const regressionRequired = (details) => new AppError('Troque o modelo somente depois de a regressão passar.', 409, 'AI_REGRESSION_REQUIRED', details);
const goldenInsufficient = (details) => new AppError('O conjunto de testes do agente não cobre todas as categorias aplicáveis.', 409, 'AI_GOLDEN_INSUFFICIENT', details);

module.exports = { regressionRequired, goldenInsufficient };
