'use strict';

// Passo 11 do orquestrador (D020), parte de grounding: lê a configuração da empresa, valida a saída, cria a recomendação de
// confirmação humana quando o prazo/contrato é crítico e devolve os campos que o orquestrador grava no estado final do run
// (grounding_status, snapshot_at, confidence). Não finaliza o run: isso é do orquestrador, em UMA transação, depois de validar.

const { loadGroundingSettings } = require('./groundingSettings');
const { validateGrounding } = require('../groundingValidator');
const { createConfirmationRecommendation } = require('./confirmationRecommendation');
const { getAgentHooks } = require('../../agents/agentHooks');

async function finalizeGrounding(ctx, input, transaction) {
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

module.exports = { finalizeGrounding };
