'use strict';

const { AiOrchestrator } = require('../../orchestrator');
const { loadChannelContext } = require('../../orchestrator/executionContext');
const { loadAtendimentoParams } = require('./atendimento.params');
const { classifyMessage } = require('./triage');
const { registerAtendimentoHooks } = require('./hooks');
const { AGENT_CODE } = require('./definition');

const DEFAULT_PURPOSE = 'Atendimento a cliente por canal externo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Uma mensagem do cliente ao NAY Atendimento. Quem chama é o CANAL (site, WhatsApp), por código do servidor: o chamador é a identidade
 * de serviço ativa do agente na empresa (só leitura, D017) e `externalContactId` é o contato do CRM que o canal resolveu (nulo se
 * desconhecido). Nenhum dos dois vem do modelo nem do texto do cliente. A triagem escolhe o tipo da tarefa (regra ou modelo pequeno); o
 * resto é o orquestrador (D020). `deps` substitui as dependências do orquestrador (testes). `prepareAtendimentoChat` devolve só o pedido
 * (`input`) e a identidade (`auth`) para a rota abrir o run antes de executar; `atendimentoChat` devolve o resultado do run.
 */
async function prepareAtendimentoChat({ groupId, companyId, message, externalContactId = null, purpose, correlationId, idempotencyKey }, transaction) {
  registerAtendimentoHooks();
  if (externalContactId !== null && !UUID.test(String(externalContactId))) throw new TypeError('externalContactId precisa ser o id do contato do CRM.');
  const tenant = { groupId, companyId };
  const service = await loadChannelContext(tenant, AGENT_CODE, externalContactId, transaction, { correlationId });
  const triage = classifyMessage(message, await loadAtendimentoParams(tenant, transaction));
  const auth = { userId: null, groupId, companyId, permissions: [...service.permissions], roles: [], serviceContext: service };
  const input = { agentCode: AGENT_CODE, purpose: purpose || DEFAULT_PURPOSE, input: message, taskType: triage.taskType, idempotencyKey, correlationId };
  return { input, auth };
}

/** Preparo + execução na mesma transação (uso dos canais internos e dos testes). A rota HTTP prepara e abre o run antes da transação da execução. */
async function atendimentoChat(args, transaction, deps = {}) {
  const { input, auth } = await prepareAtendimentoChat(args, transaction);
  return new AiOrchestrator(deps).run(input, auth, transaction);
}

module.exports = { atendimentoChat, prepareAtendimentoChat };
