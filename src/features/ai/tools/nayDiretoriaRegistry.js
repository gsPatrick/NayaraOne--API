'use strict';

// M9-D695 — registro e chamada da NAY Diretoria. O catálogo é FECHADO: as 7 ferramentas de leitura do BI e nenhuma outra. O registro é do
// Bloco A (ToolRegistry, que valida permissão, risco, schemas e recusa consulta livre); a chamada passa pelo pipeline de segurança de
// sempre (allowlist, permissão efetiva, entidade, schema) e qualquer recusa conta em ai.tool_calls_blocked.
const { ToolRegistry } = require('./ToolRegistry');
const { loadPermissionCodes } = require('./bootRegistry');
const { runToolCall } = require('../orchestrator/toolCallPipeline');
const { NAY_TOOL_DEFINITIONS, NAY_TOOL_NAMES, assertNayToolAllowed, countBlocked } = require('../../analytics/briefs');

const NAY_DIRETORIA_AGENT_CODE = 'NAY_DIRETORIA';

/** Registro com SÓ as 7 ferramentas do BI. `permissionCodes` opcional (sem ele lê core.permissions). */
async function buildNayDiretoriaRegistry(permissionCodes) {
  const registry = new ToolRegistry({ permissionCodes: permissionCodes || await loadPermissionCodes() });
  registry.registerAll(NAY_TOOL_DEFINITIONS);
  return registry;
}

/** Allowlist do agente NAY Diretoria: exatamente as 7 ferramentas, todas habilitadas. */
const nayDiretoriaAllowlist = () => NAY_TOOL_NAMES.map((toolName) => ({ toolName, enabled: true }));

/**
 * Chamada de ferramenta da NAY Diretoria. Ferramenta fora do catálogo: 403 ANALYTICS_AI_TOOL_NOT_ALLOWED antes de qualquer outra coisa
 * (e contada). Qualquer outra recusa de segurança do pipeline (permissão, empresa, argumento, segredo) também é contada.
 */
async function runNayDiretoriaToolCall(params) {
  assertNayToolAllowed(params.toolName);
  try {
    return await runToolCall({ ...params, registry: params.registry || await buildNayDiretoriaRegistry() });
  } catch (err) {
    const reason = err && err.details && err.details.blockedReason;
    if (reason || (err && (err.code === 'AI_CAPABILITY_FORBIDDEN' || err.code === 'AI_TOOL_NOT_ALLOWED'))) countBlocked(reason || err.code);
    throw err;
  }
}

module.exports = { NAY_DIRETORIA_AGENT_CODE, buildNayDiretoriaRegistry, nayDiretoriaAllowlist, runNayDiretoriaToolCall };
