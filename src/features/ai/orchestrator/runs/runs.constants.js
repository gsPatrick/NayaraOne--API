'use strict';

/** Constantes do registro de execução da NAY (M9-D005). Os valores seguem o livro; não há regra variável aqui. */
const STATUSES = Object.freeze(['RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'CANCELLED']);
const FINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const TRANSITIONS = Object.freeze({
  RUNNING: ['COMPLETED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['COMPLETED', 'CANCELLED'],
});
const ROUTING_PATHS = Object.freeze(['RULE', 'SMALL_MODEL', 'ADVANCED_MODEL', 'CACHE']);
const GROUNDING = Object.freeze(['GROUNDED', 'INSUFFICIENT_SOURCES', 'NOT_APPLICABLE', 'CONFLICTING_SOURCES']);
const SOURCE_TYPES = Object.freeze(['READ_MODEL', 'DOCUMENT_CHUNK', 'KNOWLEDGE_ENTRY', 'MEMORY', 'TOOL_RESULT']);
const CLASSIFICATIONS = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
const SOURCE_STATUSES = Object.freeze(['VIGENTE', 'REVOGADA', 'EXPIRADA']);

/** Estado final -> evento do livro (COMPLETED; FAILED e BLOCKED; os demais não emitem). A tabela vive em events/aiEvents.js (D029). */
const { RUN_EVENT_BY_STATUS: EVENT_BY_STATUS } = require('../../events/aiEvents');

/** Motivo de bloqueio -> frase em português para "A NAY não pôde concluir: <motivo>". Motivo desconhecido usa a frase genérica. */
const BLOCKED_MESSAGES = Object.freeze({
  TOOL_LIMIT: 'o limite de ferramentas por consulta foi atingido',
  TOKEN_LIMIT: 'o limite de processamento da consulta foi atingido',
  POLICY: 'a política do agente não permite esta resposta',
  BUDGET: 'o orçamento de uso da NAY foi atingido',
  INJECTION: 'o conteúdo consultado tentou dar instruções à NAY',
  PERMISSION: 'você não tem permissão para os dados necessários',
  INSUFFICIENT_SOURCES: 'não há fontes autorizadas suficientes',
});
const BLOCKED_GENERIC = 'a consulta não pôde ser concluída com segurança';

module.exports = {
  STATUSES, FINAL_STATUSES, TRANSITIONS, ROUTING_PATHS, GROUNDING, SOURCE_TYPES, CLASSIFICATIONS, SOURCE_STATUSES,
  EVENT_BY_STATUS, BLOCKED_MESSAGES, BLOCKED_GENERIC,
};
