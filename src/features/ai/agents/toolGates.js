'use strict';

/**
 * Habilitação de tool por configuração da empresa (M9-D036). A allowlist da versão do agente é imutável fora de DRAFT; uma tool cadastrada
 * DESABILITADA pode ser habilitada em cada run por um portão registrado aqui `(agente, tool) -> (ctx, transaction) => boolean`. O portão só
 * LIGA tool desabilitada; nunca desliga uma habilitada, e o modelo não o vê nem o escolhe.
 */
const gates = new Map();
const additions = new Map();

const keyOf = (agentCode, toolName) => `${String(agentCode).toUpperCase()}|${toolName}`;

function registerToolGate(agentCode, toolName, isOpen) {
  if (typeof isOpen !== 'function') throw new TypeError('o portão da tool precisa ser uma função');
  gates.set(keyOf(agentCode, toolName), isOpen);
}

/**
 * Tool que NÃO está na allowlist da versão e só passa a valer, enquanto o portão estiver aberto, como linha extra (M9-D034: a proposta
 * de tarefa do agente comercial, que o livro só libera depois do piloto). `row`: { toolName, permissionCode, riskLevel, requiresHumanApproval, enabled }.
 */
function registerToolAddition(agentCode, row, isOpen) {
  if (typeof isOpen !== 'function') throw new TypeError('o portão da tool precisa ser uma função');
  additions.set(keyOf(agentCode, row.toolName), { agentCode: String(agentCode).toUpperCase(), row: Object.freeze({ ...row }), isOpen });
}

/** Cópia do agente com as tools desabilitadas cujo portão está aberto marcadas como habilitadas; sem portão aplicável, o próprio agente. */
async function applyToolGates(agent, ctx, transaction) {
  if (!agent || !Array.isArray(agent.tools)) return agent;
  let changed = false;
  const tools = [];
  for (const tool of agent.tools) {
    const gate = tool.enabled ? null : gates.get(keyOf(agent.code, tool.toolName));
    if (gate && (await gate(ctx, transaction)) === true) { changed = true; tools.push({ ...tool, enabled: true }); } else tools.push(tool);
  }
  for (const add of additions.values()) {
    if (add.agentCode !== String(agent.code).toUpperCase() || tools.some((t) => t.toolName === add.row.toolName)) continue;
    if ((await add.isOpen(ctx, transaction)) === true) { changed = true; tools.push({ ...add.row }); }
  }
  return changed ? { ...agent, tools } : agent;
}

module.exports = { registerToolGate, registerToolAddition, applyToolGates };
