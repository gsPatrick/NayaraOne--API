'use strict';

const AppError = require('../../../utils/AppError');

const exhausted = (details) => new AppError('O orçamento de IA deste período acabou.', 429, 'AI_BUDGET_EXHAUSTED', details);
const degraded = (details) => new AppError('O orçamento de IA deste período está perto do fim: só respostas simples estão liberadas.', 429, 'AI_BUDGET_EXHAUSTED', details);
const notConfigured = () => new AppError('Configure o orçamento de IA da empresa antes de usar a NAY.', 403, 'AI_BUDGET_NOT_CONFIGURED');
const belowConsumed = (details) => new AppError('O limite não pode ser menor que o valor já consumido.', 400, 'AI_BUDGET_BELOW_CONSUMED', details);
const invalid = (message, details) => new AppError(message, 400, 'AI_BUDGET_INVALID', details);
const notFound = () => new AppError('Orçamento não encontrado.', 404, 'AI_BUDGET_NOT_FOUND');
const duplicate = () => new AppError('Já existe um orçamento para este escopo neste período.', 409, 'AI_BUDGET_EXISTS');

module.exports = { exhausted, degraded, notConfigured, belowConsumed, invalid, notFound, duplicate };
