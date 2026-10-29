'use strict';

const AppError = require('../../../utils/AppError');

/** Erros das rotas de execução (M9-D030). Código estável, mensagem em português, sem detalhe técnico. */
const INPUT_MESSAGE = 'Informe uma mensagem de até 8.000 caracteres.';
const inputInvalid = (message = INPUT_MESSAGE, details) => new AppError(message, 400, 'AI_INPUT_INVALID', details);
const conversationNotFound = () => new AppError('Conversa não encontrada.', 404, 'AI_CONVERSATION_NOT_FOUND');
const conversationExpired = () => new AppError('Esta conversa expirou. Inicie uma nova conversa.', 410, 'AI_CONVERSATION_EXPIRED');

module.exports = { inputInvalid, conversationNotFound, conversationExpired, INPUT_MESSAGE };
