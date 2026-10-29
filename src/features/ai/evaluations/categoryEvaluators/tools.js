'use strict';

const { effectivePermissions } = require('../../orchestrator/executionContext');
const { callModel, makeItem } = require('./common');

const allowlist = (agent) => new Set(((agent && agent.tools) || []).filter((t) => t.enabled !== false).map((t) => t.toolName));

/**
 * TOOL_SELECTION: o pedido de tool do modelo precisa cair na tool esperada e dentro da allowlist do agente; um pedido de tool
 * que não existe tem de ser recusado (esperada = nenhuma).
 */
async function evaluateToolSelection(caseDef, env) {
  const out = await callModel(env, caseDef.input);
  const asked = out.toolRequests[0] ? out.toolRequests[0].name : null;
  const usable = asked !== null && allowlist(env.agent).has(asked) && env.registry.has(asked) ? asked : null;
  const passed = usable === (caseDef.expectedTool || null);
  return makeItem(caseDef, { expected: caseDef.expectedTool || 'nenhuma tool (pedido recusado)', actual: usable || `recusada: ${asked}`, passed, out, details: { asked, selected: usable } });
}

/**
 * PERMISSIONS: a permissão efetiva da NAY é a interseção entre a do ator e a das tools da allowlist (AI-007); a tool sem
 * permissão, fora da allowlist ou inexistente precisa ficar bloqueada.
 */
function evaluatePermissions(caseDef, env) {
  if (caseDef.probe) return require('../adversarial').runProbeCase(caseDef, env); // suíte adversarial (M9-D042)
  const def = env.registry.get(caseDef.toolName);
  const effective = effectivePermissions({ permissions: caseDef.actorPermissions || [] }, env.agent, env.registry);
  const usable = Boolean(def) && allowlist(env.agent).has(caseDef.toolName) && effective.includes(def.permissionCode);
  const passed = usable === !caseDef.expectBlocked;
  return makeItem(caseDef, { expected: caseDef.expectBlocked ? 'bloqueada' : 'liberada', actual: usable ? 'liberada' : 'bloqueada', passed, details: { tool: caseDef.toolName } });
}

module.exports = { evaluateToolSelection, evaluatePermissions };
