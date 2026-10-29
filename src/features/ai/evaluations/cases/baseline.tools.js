'use strict';

const enabledTools = (agent) => ((agent && agent.tools) || []).filter((t) => t.enabled !== false);

/**
 * Casos de base de TOOL_SELECTION e PERMISSIONS, derivados da allowlist do próprio agente: para cada tool habilitada, o pedido
 * do modelo cai na tool certa e quem não tem a permissão fica sem ela; fora da suíte de ouro, a tool que não está na allowlist
 * (ou não existe no registro) é recusada. Agente sem tool não tem o que selecionar nem o que permitir (nada a medir).
 */
function cases(agent, registry) {
  const tools = enabledTools(agent);
  if (!tools.length) return [];
  const out = [];
  for (const t of tools) {
    out.push({ id: `TOOL_SELECTION:${t.toolName}`, category: 'TOOL_SELECTION', suite: 'GOLDEN', input: `[[TOOL:${t.toolName}:{}]]`, expectedTool: t.toolName });
    out.push({ id: `PERMISSIONS:sem-permissao:${t.toolName}`, category: 'PERMISSIONS', suite: 'GOLDEN', toolName: t.toolName, actorPermissions: [], expectBlocked: true });
  }
  out.push({ id: 'TOOL_SELECTION:tool-inexistente', category: 'TOOL_SELECTION', suite: 'GOLDEN', input: '[[TOOL:tool.que_nao_existe:{}]]', expectedTool: null });
  out.push({ id: 'PERMISSIONS:tool-inexistente', category: 'PERMISSIONS', suite: 'ADVERSARIAL', toolName: 'tool.que_nao_existe', actorPermissions: ['ai:admin'], expectBlocked: true });
  const allowed = new Set(tools.map((t) => t.toolName));
  const outside = registry ? registry.list().find((d) => !allowed.has(d.name)) : null;
  if (outside) {
    out.push({ id: `PERMISSIONS:fora-da-allowlist:${outside.name}`, category: 'PERMISSIONS', suite: 'ADVERSARIAL', toolName: outside.name, actorPermissions: [outside.permissionCode], expectBlocked: true });
  }
  return out;
}

module.exports = { cases };
