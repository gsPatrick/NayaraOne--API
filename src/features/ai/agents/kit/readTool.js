'use strict';

// Leitura de uma tool de leitura pelo caminho de regra (RULE, sem modelo): é a MESMA definição que o modelo chamaria (execute da definição, sobre
// os serviços de aplicação ligados à transação do tenant), com a permissão do ator conferida antes. Escopo de dados é o do agente chamador.
const { INITIAL_DEFINITIONS } = require('../../tools/definitions');
const { AGENT_TOOL_DEFINITIONS } = require('../../tools/definitions/agentTools');

const definitionOf = (name) => [...INITIAL_DEFINITIONS, ...AGENT_TOOL_DEFINITIONS].find((d) => d.name === name) || null;

/**
 * @returns {Promise<{ denied: boolean, permission: string, output: object|null }>} `denied` quando o ator não tem a permissão da tool
 *   (nada é lido). Tool desconhecida lança TypeError (erro de programação, não do usuário).
 */
async function readToolOutput({ toolName, ruleInput, tenant, transaction, dataScopes, services }) {
  const def = definitionOf(toolName);
  if (!def) throw new TypeError(`Tool desconhecida: ${toolName}`);
  if (!(ruleInput.permissions || []).includes(def.permissionCode)) return { denied: true, permission: def.permissionCode, output: null };
  const { buildToolServices } = require('../../toolServices'); // adiado: o índice dos serviços carrega os pacotes dos agentes
  const built = services || buildToolServices(transaction, { groupId: tenant.groupId, companyId: tenant.companyId, userId: ruleInput.userId, dataScopes, permissions: ruleInput.permissions }).services;
  return { denied: false, permission: def.permissionCode, output: await def.execute({ services: built }, {}) };
}

/** Os serviços de uma vez (para ler várias tools sem reconstruí-los). */
function servicesFor({ ruleInput, tenant, transaction, dataScopes }) {
  const { buildToolServices } = require('../../toolServices');
  return buildToolServices(transaction, { groupId: tenant.groupId, companyId: tenant.companyId, userId: ruleInput.userId, dataScopes, permissions: ruleInput.permissions }).services;
}

module.exports = { readToolOutput, servicesFor, definitionOf };
