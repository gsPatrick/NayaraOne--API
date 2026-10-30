'use strict';

const { AiOrchestrator } = require('../orchestrator');
const { initToolRegistry } = require('../tools');
const { parseRunBody, parseChatBody } = require('./runApi.validation');
const { readRunApiParams } = require('./runApi.params');
const { resolveConversation, chatPurpose } = require('./conversation');
const { isAtendimento, prepareChannelRequest } = require('./atendimentoChannel');

/** O que o orquestrador precisa saber da pessoa (nunca vem do corpo do pedido). */
const authOf = (auth) => ({
  userId: auth.userId, groupId: auth.groupId, companyId: auth.companyId, permissions: auth.permissions || [], roles: auth.roles || [],
});

/**
 * Prepara um pedido de /ai/runs (kind RUN) ou de /ai/agents/:code/chat (kind CHAT) e ABRE o run, na transação recebida (a do preparo; quem
 * chama a confirma). Valida o corpo (400 antes de existir run), resolve a conversa do chat, conta a taxa por pessoa sob trava e grava o run
 * RUNNING. Devolve `{ opened, execute }`: `execute(transaction)` roda o restante do fluxo numa transação NOVA e devolve `{ outcome,
 * conversationId, params }`. Assim cada pedido segura uma conexão por vez (antes a abertura numa transação própria dentro da transação do
 * pedido pedia duas e uma rajada acima do pool travava a API).
 */
async function prepareRequest({ kind, agentCode, body }, auth, transaction, deps = {}) {
  const who = authOf(auth);
  const params = await readRunApiParams(who, transaction);
  // Chat do NAY_ATENDIMENTO: é o do canal externo (identidade de serviço e contato resolvidos pelo servidor), não o de uma pessoa.
  if (kind === 'CHAT' && isAtendimento(agentCode)) {
    const channel = await prepareChannelRequest({ body }, who, transaction, deps, params.inputMax);
    const orchestrator = new AiOrchestrator(channel.deps);
    const opened = await orchestrator.open(channel.input, channel.auth, transaction);
    return { opened, execute: async (tx) => ({ outcome: await orchestrator.run(channel.input, channel.auth, tx, opened), conversationId: null, params }) };
  }
  const parsed = kind === 'CHAT' ? parseChatBody(agentCode, body, chatPurpose(agentCode), params.inputMax) : parseRunBody(body, params.inputMax);
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
  const input = { ...parsed, conversationId, history };
  const opened = await orchestrator.open(input, who, transaction);
  return { opened, execute: async (tx) => ({ outcome: await orchestrator.run(input, who, tx, opened), conversationId, params }) };
}

/**
 * Prepara e executa um pedido na MESMA transação (serviços internos e testes): o resultado do orquestrador (`ok: false` leva o HTTP e o
 * código da tabela "Falha por passo"). Quem chama confirma a transação mesmo com `ok: false`. A rota HTTP usa `prepareRequest` em duas.
 */
async function executeRequest(request, auth, transaction, deps = {}) {
  const prepared = await prepareRequest(request, auth, transaction, deps);
  return prepared.execute(transaction);
}

module.exports = { executeRequest, prepareRequest, authOf };
