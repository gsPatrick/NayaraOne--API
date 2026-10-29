'use strict';

const { registerAgentHooks } = require('../agentHooks');
const { loadAtendimentoParams } = require('./atendimento.params');
const { classifyMessage, promisesSomething, CATEGORIES } = require('./triage');
const { AGENT_CODE } = require('./definition');
const { ruleResolvers } = require('../../providers/router/resolvers/ruleResolvers');
const { buildResolvers } = require('./resolvers');

const tenantOf = (state) => ({ groupId: state.ctx.groupId, companyId: state.ctx.companyId });
const RESUMO = {
  CANAL_EXTERNO: 'Cliente pediu envio de mensagem por canal externo; só o fluxo de Marketing e Integrações pode enviar.',
  FORA_DA_POLITICA: 'Cliente fez pedido fora da política homologada (valor, desconto, prazo ou condição).',
};

/**
 * Ganchos do agente no run. O servidor, e não o modelo, decide o que vale:
 *  - a triagem roda sobre a mensagem do cliente em qualquer tipo de tarefa; pedido fora da política ou de envio externo SEMPRE chama a
 *    tool de encaminhamento (que registra o pedido para uma pessoa) e a resposta é o texto fixo configurado;
 *  - dado de outro cliente é recusado com o texto de fora do escopo;
 *  - resposta do modelo com promessa em nome da empresa é trocada pelo texto de "sem promessa".
 */
async function serverTools(state) {
  const params = await loadAtendimentoParams(tenantOf(state), state.transaction);
  const triage = classifyMessage(state.parsed.input, params);
  if (!triage.handoffTopic) return [];
  return [{ name: 'crm.createHandoffTask', arguments: { topic: triage.handoffTopic, summary: RESUMO[triage.category] } }];
}

async function checkAnswer(state, text) {
  const params = await loadAtendimentoParams(tenantOf(state), state.transaction);
  const triage = classifyMessage(state.parsed.input, params);
  if (triage.category === CATEGORIES.OUTRO_CLIENTE) return params.mensagemForaDoEscopo;
  if (triage.handoffTopic) return params.mensagemEncaminhamento;
  return promisesSomething(text, params) ? params.mensagemSemPromessa : text;
}

let registered = false;
/** Registra os ganchos e os resolvedores de regra do agente (uma vez por processo). */
function registerAtendimentoHooks() {
  if (registered) return;
  registered = true;
  registerAgentHooks(AGENT_CODE, { serverTools, requiredServerTools: true, checkAnswer });
  for (const [taskType, resolver] of Object.entries(buildResolvers())) ruleResolvers.register(taskType, resolver);
}

module.exports = { registerAtendimentoHooks, serverTools, checkAnswer };
