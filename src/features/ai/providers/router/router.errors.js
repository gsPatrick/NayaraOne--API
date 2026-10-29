'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do roteador de modelo (M9-D012). O 429 de orçamento é o da M9-D014 (budgets.errors). */
const noEligibleModel = (details) => new AppError('Nenhum modelo disponível atende a esta tarefa com segurança.', 503, 'AI_NO_ELIGIBLE_MODEL', details);
const invalidInput = (message) => new AppError(message, 400, 'AI_ROUTER_INVALID', undefined);

module.exports = { noEligibleModel, invalidInput };
