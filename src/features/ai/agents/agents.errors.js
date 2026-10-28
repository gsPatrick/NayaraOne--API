'use strict';

const AppError = require('../../../utils/AppError');

/** Erros de agentes versionados (M9-D004). Código estável, mensagem em português, sem detalhe técnico. */
const invalid = (message, details) => new AppError(message, 400, 'AI_AGENT_INVALID', details);
const toolInvalid = (message, details) => new AppError(message, 400, 'AI_AGENT_TOOL_INVALID', details);
const notFound = () => new AppError('Agente não encontrado.', 404, 'AI_AGENT_NOT_FOUND');
const immutable = () => new AppError('Versão ativa não pode ser editada; crie uma nova versão.', 409, 'AI_AGENT_IMMUTABLE');
const systemDefault = () => new AppError('O padrão do sistema não é alterado; crie uma versão da empresa a partir dele.', 409, 'AI_AGENT_SYSTEM_DEFAULT');
const notHomologated = () => new AppError('A versão precisa de avaliação verde e homologação humana.', 409, 'AI_AGENT_NOT_HOMOLOGATED');
const evaluationRequired = () => new AppError('A versão precisa de avaliação verde antes da homologação.', 409, 'AI_AGENT_EVALUATION_REQUIRED');
const badTransition = (from, to) => new AppError(`A versão não pode passar de ${from} para ${to}.`, 409, 'AI_AGENT_TRANSITION', { from, to });
const segregation = (message) => new AppError(message, 403, 'AI_AGENT_SEGREGATION');
const versionConflict = () => new AppError('Outra pessoa alterou este agente ao mesmo tempo; tente de novo.', 409, 'AI_AGENT_VERSION_CONFLICT');
const toolNotAllowed = (toolName) => new AppError('Este agente não pode usar esta ferramenta.', 403, 'AI_TOOL_NOT_ALLOWED', { tool: String(toolName || '') });
const toolLimit = () => new AppError('A NAY atingiu o limite de ferramentas por consulta.', 422, 'AI_TOOL_LIMIT_EXCEEDED', { runStatus: 'BLOCKED', blockedReason: 'TOOL_LIMIT' });
const tokenLimit = () => new AppError('A NAY atingiu o limite de processamento desta consulta.', 422, 'AI_TOKEN_LIMIT_EXCEEDED', { runStatus: 'FAILED', blockedReason: 'TOKEN_LIMIT' });
const rateLimited = () => new AppError('Muitas consultas à NAY em pouco tempo; aguarde um instante.', 429, 'AI_RATE_LIMITED');

/** Traduz a recusa do banco (gatilhos AI001-AI004 e unicidade) para o erro estável da API; devolve null se não for dele. */
function fromDbError(err) {
  const parent = err && (err.parent || err.original || err);
  const code = parent && parent.code;
  const message = String((parent && parent.message) || '');
  if (code === 'AI001') return immutable();
  if (code === 'AI003') return new AppError(message.replace(/^AI_AGENT_TRANSITION:\s*/, '') || 'Transição de estado não permitida.', 409, 'AI_AGENT_TRANSITION');
  if (code === 'AI004') return notHomologated();
  if (code === 'AI002') return toolInvalid('A ferramenta não pertence a este agente.');
  if (code === '23505' && /ai_agents_(company_code_version|one_active|idempotency)_uq/.test(`${parent.constraint || ''} ${message}`)) return versionConflict();
  return null;
}

module.exports = {
  invalid, toolInvalid, notFound, immutable, systemDefault, notHomologated, evaluationRequired, badTransition, segregation,
  versionConflict, toolNotAllowed, toolLimit, tokenLimit, rateLimited, fromDbError,
};
