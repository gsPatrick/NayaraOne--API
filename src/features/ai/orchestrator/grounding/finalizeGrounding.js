'use strict';

// Passo 11 do orquestrador (D020), parte de grounding: lê a configuração da empresa, valida a saída, cria a recomendação de
// confirmação humana quando o prazo/contrato é crítico e devolve os campos que o orquestrador grava no estado final do run
// (grounding_status, snapshot_at, confidence). Não finaliza o run: isso é do orquestrador, em UMA transação, depois de validar.

const { loadGroundingSettings } = require('./groundingSettings');
const { validateGrounding } = require('../groundingValidator');
const { createConfirmationRecommendation } = require('./confirmationRecommendation');
const { getAgentHooks } = require('../../agents/agentHooks');

const NOT_APPLICABLE = (text) => ({
  factual: false, groundingStatus: 'NOT_APPLICABLE', answer: text, sources: [], consulted: [], snapshotAt: null, snapshotAtLocal: null,
  confidence: null, confidenceLabel: null, requiresHumanConfirmation: false, confirmationRequest: null, removedClaims: 0, notices: [],
});

/** A tarefa é do servidor e ele mesmo confere os números com a fonte exata (agentHooks.serverGroundedTasks)? */
const isServerGrounded = (agentCode, taskType) => {
  const list = (getAgentHooks(agentCode) || {}).serverGroundedTasks;
  return Array.isArray(list) && list.includes(String(taskType || '').toLowerCase());
};

async function finalizeGrounding(ctx, input, transaction) {
  if (isServerGrounded(input.agentCode, input.taskType)) {
    const result = NOT_APPLICABLE(String((input && input.answerText) || ''));
    return { ...result, recommendation: null, runFields: { groundingStatus: result.groundingStatus } };
  }
  const settings = await loadGroundingSettings(ctx, transaction);
  const result = validateGrounding(input, settings);
  let recommendation = null;
  // Agente somente leitura (ex.: NAY Correspondente, M9-D039): o aviso de confirmação humana fica no texto, mas nenhuma recomendação é criada.
  const readOnly = Boolean((getAgentHooks(input.agentCode) || {}).readOnly);
  if (result.requiresHumanConfirmation && input.runId && !readOnly) {
    recommendation = await createConfirmationRecommendation(ctx, {
      runId: input.runId, agentCode: input.agentCode, request: result.confirmationRequest, snapshotAt: result.snapshotAt, groundingStatus: result.groundingStatus,
    }, transaction);
  }
  const runFields = { groundingStatus: result.groundingStatus, snapshotAt: result.snapshotAt || undefined, confidence: result.confidence || undefined };
  return { ...result, recommendation, runFields };
}

module.exports = { finalizeGrounding, isServerGrounded };
