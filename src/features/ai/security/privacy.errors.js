'use strict';

const AppError = require('../../../utils/AppError');

/** Erros da privacidade da NAY (M9-D027). Código estável, mensagem em português, sem o conteúdo recusado. */
const restrictedNotAllowed = (details) => new AppError(
  'Este conteúdo é restrito e não pode ser usado pela NAY nesta consulta.', 403, 'AI_RESTRICTED_NOT_ALLOWED', details
);
const taskTypeUnknown = (taskType) => new AppError('Tipo de tarefa da NAY desconhecido.', 422, 'AI_TASK_TYPE_UNKNOWN', { taskType: String(taskType) });
const accessGuardRequired = () => new AppError('Guarda de acesso a campos da NAY indisponível.', 500, 'AI_ACCESS_GUARD_REQUIRED');
const contextInvalid = (message) => new AppError(message, 400, 'AI_CONTEXT_INVALID');

module.exports = { restrictedNotAllowed, taskTypeUnknown, accessGuardRequired, contextInvalid };
