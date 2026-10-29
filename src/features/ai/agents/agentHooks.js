'use strict';

/**
 * Ganchos de comportamento de um agente no run (M9-D041). Cada agente (pasta em agents/<nome>/) registra os seus pelo código; o
 * orquestrador os consulta sem conhecer o agente. Os ganchos são regra do SERVIDOR: o modelo não os escolhe nem os desliga.
 *  - `serverTools(state)`: pedidos de tool que o servidor decide fazer antes da geração (ex.: encaminhar a um humano), passando pelo
 *    mesmo pipeline de segurança de qualquer tool; devolve [{ name, arguments }];
 *  - `requiredServerTools`: true = falha em alguma delas encerra o run com erro (nunca responder como se tivesse feito);
 *  - `checkAnswer(state, text)`: última palavra sobre o texto da resposta (substituir resposta proibida); devolve o texto.
 */
const hooks = new Map();

function registerAgentHooks(agentCode, definition) {
  if (typeof agentCode !== 'string' || !agentCode.trim()) throw new TypeError('registerAgentHooks precisa do código do agente');
  hooks.set(agentCode.toUpperCase(), Object.freeze({ ...definition }));
}

const getAgentHooks = (agentCode) => hooks.get(String(agentCode || '').toUpperCase()) || null;

module.exports = { registerAgentHooks, getAgentHooks };
