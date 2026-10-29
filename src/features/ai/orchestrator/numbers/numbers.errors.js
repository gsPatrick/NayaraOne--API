'use strict';

const AppError = require('../../../../utils/AppError');

/** Número no texto que não vem de read model nem de fonte conhecida, depois da nova geração (422). */
const numberNotFromSource = (details) => AppError.unprocessable('A resposta continha valores que não vêm das fontes e foi bloqueada.', 'AI_NUMBER_NOT_FROM_SOURCE', details);

module.exports = { numberNotFromSource };
