'use strict';

const MODEL_PATHS = ['SMALL_MODEL', 'ADVANCED_MODEL'];

/**
 * Depois do passo 11, guarda no cache seguro (D015) a resposta de um run de modelo que terminou COMPLETED. Quem decide se vale é a
 * elegibilidade do cache (classificação, PII, ação, grounding, lista `cacheableTaskTypes`); aqui só se monta o pedido. Resposta de regra
 * ou de cache não é guardada de novo; run que chamou tool, criou proposta ou recomendação, ou levou aviso, é tratado como ação.
 */
async function cacheAnswer(state, { run, answer, grounded }) {
  const store = state.deps.cacheStore;
  if (typeof store !== 'function' || !run || run.status !== 'COMPLETED' || !MODEL_PATHS.includes(state.decision.path)) return null;
  const policy = state.agent.modelPolicy || {};
  const isAction = state.seq > 0 || state.proposals.length > 0 || Boolean(grounded.recommendation) || state.unmet.length > 0 || state.notices.length > 0;
  return store(state.ctx, {
    agentCode: state.agent.code, agentVersion: state.agent.version, taskType: state.parsed.taskType, cacheableTaskTypes: policy.cacheableTaskTypes || [],
    permissions: state.ctx.permissions || [], input: state.parsed.input, purpose: state.parsed.purpose, answer, sources: state.sources, groundingStatus: grounded.groundingStatus,
    isAction, snapshotAt: grounded.snapshotAt || null, providerCode: run.providerCode, modelCode: run.modelCode,
  }, state.transaction);
}

module.exports = { cacheAnswer };
