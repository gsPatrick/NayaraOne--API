'use strict';

const { AiOrchestrator } = require('../orchestrator');
const { initToolRegistry } = require('../tools');
const { parseRunBody, parseChatBody } = require('./runApi.validation');
const { readRunApiParams } = require('./runApi.params');
const { resolveConversation, chatPurpose } = require('./conversation');

/** O que o orquestrador precisa saber da pessoa (nunca vem do corpo do pedido). */
const authOf = (auth) => ({
  userId: auth.userId, groupId: auth.groupId, companyId: auth.companyId, permissions: auth.permissions || [], roles: auth.roles || [],
});

/**
 * Executa um pedido de /ai/runs (kind RUN) ou de /ai/agents/:code/chat (kind CHAT) pelo AiOrchestrator, na transação do tenant.
 * Valida o corpo (400 antes de existir run), resolve a conversa do chat e devolve `{ outcome, conversationId }`; `outcome` é o resultado
 * do orquestrador (`ok: false` leva o HTTP e o código da tabela "Falha por passo"). Quem chama confirma a transação mesmo com `ok: false`.
 */
async function executeRequest({ kind, agentCode, body }, auth, transaction, deps = {}) {
  const who = authOf(auth);
  const parsed = kind === 'CHAT' ? parseChatBody(agentCode, body, chatPurpose(agentCode)) : parseRunBody(body);
  const params = await readRunApiParams(who, transaction);
  let conversationId = null;
  let history = [];
  if (kind === 'CHAT') {
    const nowMs = deps.clock ? deps.clock() : Date.now();
    ({ conversationId, history } = await resolveConversation(who, parsed, {
      maxMessages: params.chatMaxMessages, validityHours: params.conversationValidityHours, nowMs,
    }, transaction));
  }
  // O registro de tools é montado uma vez por processo (no boot, ou aqui no primeiro uso quando o boot não o montou, como nos testes).
  const orchestrator = new AiOrchestrator({ ...deps, toolRegistry: deps.toolRegistry || await initToolRegistry() });
  const outcome = await orchestrator.run({ ...parsed, conversationId, history }, who, transaction);
  return { outcome, conversationId, params };
}

module.exports = { executeRequest, authOf };
