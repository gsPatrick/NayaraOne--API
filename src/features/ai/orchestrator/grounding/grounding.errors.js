'use strict';

const AppError = require('../../../../utils/AppError');

/** Resposta factual sem fonte, quando a empresa escolheu bloquear em vez de responder com insuficiência (422). */
const ungroundedFact = () => AppError.unprocessable('A resposta foi bloqueada porque não cita fontes internas.', 'AI_UNGROUNDED_FACT');

module.exports = { ungroundedFact };
