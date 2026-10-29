'use strict';

/**
 * Conjuntos de tarefas do roteador (M9-D012, Guia §10): modelo econômico para classificação/resumo simples, modelo avançado para
 * raciocínio/documentos complexos. Tarefa fora dos dois conjuntos começa no modelo pequeno (o mais barato) e só escala se a saída
 * não passar na validação ou vier com confiança baixa.
 */
const SMALL_TASKS = Object.freeze(['classificar', 'triar', 'extrair_simples', 'resumir_curto', 'reescrever_curto']);
const ADVANCED_TASKS = Object.freeze(['raciocinar_multietapas', 'comparar_documentos', 'minuta_juridica', 'analisar_documento_complexo']);

const REASONS = Object.freeze({
  RULE_RESOLVER: 'RULE_RESOLVER',
  RULE_FORCED: 'RULE_FORCED_CALCULATION',
  CACHE_HIT: 'CACHE_HIT',
  SMALL_TASK: 'SMALL_TASK',
  SMALL_DEFAULT: 'SMALL_DEFAULT_UNLISTED_TASK',
  ADVANCED_TASK: 'ADVANCED_TASK',
  ADVANCED_LONG_INPUT: 'ADVANCED_INPUT_ABOVE_SMALL_LIMIT',
  ADVANCED_UNTRUSTED_DOCS: 'ADVANCED_LONG_UNTRUSTED_DOCUMENTS',
  ESCALATED: 'ESCALATED_LOW_CONFIDENCE_OR_INVALID_OUTPUT',
});

/** Classe de modelo que a tarefa pede e o motivo. `params.smallMaxTokens` é o limite de entrada do modelo pequeno. */
function classOfTask({ taskType, inputSize = 0, hasUntrustedLongDocs = false }, params) {
  const task = String(taskType || '').toLowerCase();
  if (ADVANCED_TASKS.includes(task)) return { path: 'ADVANCED_MODEL', reason: REASONS.ADVANCED_TASK };
  if (hasUntrustedLongDocs === true) return { path: 'ADVANCED_MODEL', reason: REASONS.ADVANCED_UNTRUSTED_DOCS };
  if (Number(inputSize) > params.smallMaxTokens) return { path: 'ADVANCED_MODEL', reason: REASONS.ADVANCED_LONG_INPUT };
  return { path: 'SMALL_MODEL', reason: SMALL_TASKS.includes(task) ? REASONS.SMALL_TASK : REASONS.SMALL_DEFAULT };
}

module.exports = { SMALL_TASKS, ADVANCED_TASKS, REASONS, classOfTask };
