'use strict';

/**
 * Fronteira de cada agente da NAY (M9-D037, M9-D038 e os demais agentes): o que está no propósito, o que o livro proíbe e o que a
 * resposta precisa carregar. O registro guarda só a DEFINIÇÃO (chaves de configuração, padrões e mensagens); as listas de termos
 * efetivas vêm da configuração da empresa a cada consulta (scope.guard.js). Quem registra é o pacote de cada agente.
 *
 * def: {
 *   code, outOfScopeMessage, scopeTermsKey, scopeTermsDefault,
 *   prohibitions: [{ code, label, key, defaultTerms, message, respond?(ruleInput, env) }],
 *   decorate?(answer, { taskType }) -> texto da resposta com a marca obrigatória do agente,
 *   serverTasks?: [taskType] tarefas cujo texto de entrada é montado pelo SERVIDOR (ex.: briefing_executivo), não digitado por uma pessoa: a fronteira de termos
 *   não se aplica a elas (o texto do próprio sistema contém palavras como "estime" e "calcule", justamente para proibi-las ao modelo),
 * }
 */
const scopes = new Map();

function registerAgentScope(def) {
  if (!def || typeof def.code !== 'string' || !def.code) throw new TypeError('o escopo do agente precisa do código');
  scopes.set(def.code.toUpperCase(), Object.freeze({ prohibitions: [], ...def }));
}

const getAgentScope = (code) => scopes.get(String(code || '').toUpperCase()) || null;
const listAgentScopes = () => [...scopes.values()];

module.exports = { registerAgentScope, getAgentScope, listAgentScopes };
