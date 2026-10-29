'use strict';

const runs = require('../runs');
const { persistSources } = require('./flow.sources');
const { totalCost } = require('./flow.model');

/** Campos de custo e roteamento que o run guarda (a mesma lista no passo 10, no estado final e na falha). */
function usageFields(state) {
  const fields = {
    providerCode: state.decision && state.decision.provider ? state.decision.provider : undefined,
    modelCode: state.decision && state.decision.model ? state.decision.model : undefined,
    routingPath: state.decision ? state.decision.path : undefined,
    tokensIn: state.usage.tokensIn,
    tokensOut: state.usage.tokensOut,
    costAmount: totalCost(state),
    latencyMs: Math.max(0, state.clock() - state.startedAtMs),
    escalated: state.escalated,
    cached: state.decision ? state.decision.path === 'CACHE' : false,
  };
  if (state.fallbackTrail.length) fields.fallbackTrail = state.fallbackTrail;
  return fields;
}

/**
 * Passo 10: registra fontes, custo real (tokens e valor) e caminho, mantendo o run em RUNNING. O custo já foi gasto, mesmo que a saída
 * seja reprovada no passo seguinte; uma nova tentativa de geração soma o custo extra aqui de novo.
 */
async function recordProgress(state) {
  await persistSources(state);
  return runs.recordRunProgress(state.ctx, state.runId, usageFields(state), state.transaction);
}

module.exports = { usageFields, recordProgress };
