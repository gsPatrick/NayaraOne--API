'use strict';

const AppError = require('../../../../utils/AppError');

/** Erros do fluxo de execução do run (M9-D020). Código estável, mensagem em português, sem detalhe técnico. */
const purposeRequired = () => new AppError('Informe a finalidade da consulta.', 400, 'AI_PURPOSE_REQUIRED');
const inputRequired = () => new AppError('Informe a pergunta ou o pedido para a NAY.', 400, 'AI_RUN_INVALID');
const agentNotFound = () => new AppError('Agente não encontrado.', 404, 'AI_AGENT_NOT_FOUND');
const maxTurns = () => new AppError('A NAY não conseguiu concluir dentro do limite de etapas.', 422, 'AI_MAX_TURNS_EXCEEDED');
const runTimeout = () => new AppError('A NAY demorou demais para responder. Tente novamente.', 504, 'AI_RUN_TIMEOUT');
const outputInvalid = () => new AppError('A NAY não conseguiu produzir uma resposta válida.', 422, 'AI_OUTPUT_INVALID');
const ruleUnresolved = () => new AppError('Não há resultado calculado disponível para esta tarefa.', 422, 'AI_RULE_UNRESOLVED');
const reentrant = () => new AppError('Uma ferramenta da NAY não pode iniciar outra consulta da NAY.', 409, 'AI_ORCHESTRATOR_REENTRANT');
const inProgress = () => new AppError('Esta consulta ainda está em andamento.', 409, 'AI_TOOL_CALL_IN_PROGRESS');
const providerUnavailable = (details) => new AppError('O provedor de IA está indisponível no momento.', 503, 'AI_PROVIDER_UNAVAILABLE', details);
const injectionInContent = () => new AppError('O conteúdo consultado tentou dar instruções à NAY e foi bloqueado.', 422, 'AI_INJECTION_BLOCKED');

module.exports = {
  purposeRequired, inputRequired, agentNotFound, maxTurns, runTimeout, outputInvalid, ruleUnresolved, reentrant, inProgress, providerUnavailable, injectionInContent,
};
