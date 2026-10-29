'use strict';

const { getAgentHooks } = require('../../agents/agentHooks');
const { processToolRequests } = require('./flow.tools');
const E = require('./flow.errors');

/**
 * Passo 7 a 9 das tools que o SERVIDOR decide chamar (ganchos do agente, M9-D041), antes da geração ou da resposta de regra. Passam
 * pelo mesmo pipeline do modelo (allowlist, permissão, schema, teto de tools). Devolve 'AWAITING' se uma delas virou proposta (o run para).
 * Quando o agente declara `requiredServerTools`, tool que não deu certo encerra o run: a resposta nunca finge uma ação que não houve.
 */
async function runServerTools(state) {
  const hook = getAgentHooks(state.agent.code);
  if (!hook || typeof hook.serverTools !== 'function') return null;
  const requests = await hook.serverTools(state);
  if (!requests || !requests.length) return null;
  const { results, stoppedByProposal } = await processToolRequests(state, requests);
  if (stoppedByProposal) return 'AWAITING';
  const failed = results.find((r) => r.status !== 'SUCCEEDED');
  if (failed && hook.requiredServerTools === true) throw E.serverToolFailed(failed.tool);
  return null;
}

/** Gancho de resposta do agente: devolve o texto final (o mesmo, ou o que o agente impõe no lugar). */
async function applyAnswerHook(state, text) {
  const hook = getAgentHooks(state.agent.code);
  return hook && typeof hook.checkAnswer === 'function' ? hook.checkAnswer(state, text) : text;
}

module.exports = { runServerTools, applyAnswerHook };
