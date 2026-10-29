'use strict';

// M9-D695 — registro e chamada da NAY Diretoria. O catálogo é FECHADO: as 7 ferramentas de leitura do BI e nenhuma outra. O registro é do
// Bloco A (ToolRegistry, que valida permissão, risco, schemas e recusa consulta livre); a chamada passa pelo pipeline de segurança de
// sempre (allowlist, permissão efetiva, entidade, schema) e qualquer recusa conta em ai.tool_calls_blocked.
const { ToolRegistry } = require('./ToolRegistry');
const { loadPermissionCodes } = require('./bootRegistry');
const { runToolCall } = require('../orchestrator/toolCallPipeline');
const { NAY_TOOL_DEFINITIONS, NAY_TOOL_NAMES, assertNayToolAllowed } = require('../../analytics/briefs');

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
 * Chamada de ferramenta da NAY Diretoria. Toda recusa passa pelo pipeline e vira linha BLOCKED em ai.tool_calls (motivo ALLOWLIST,
 * PERMISSION, CROSS_COMPANY, SCHEMA, SECRET...), que é o que o KPI ai.tool_calls_blocked soma e o que incrementa o contador. Ferramenta fora do
 * catálogo também segue pelo pipeline (que a recusa na allowlist e grava a linha) e termina em 403 ANALYTICS_AI_TOOL_NOT_ALLOWED.
 */
async function runNayDiretoriaToolCall(params) {
  let fora = null;
  try { assertNayToolAllowed(params.toolName); } catch (err) { fora = err; }
  try {
    const result = await runToolCall({ ...params, registry: params.registry || await buildNayDiretoriaRegistry() });
    if (fora) throw fora;
    return result;
  } catch (err) {
    if (fora && err && err.code === 'AI_TOOL_NOT_ALLOWED') throw fora;
    throw err;
  }
}

module.exports = { NAY_DIRETORIA_AGENT_CODE, buildNayDiretoriaRegistry, nayDiretoriaAllowlist, runNayDiretoriaToolCall };
