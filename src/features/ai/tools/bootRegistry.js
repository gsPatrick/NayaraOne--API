'use strict';

// M9-D016 — boot do registro de tools: monta o ToolRegistry com as definições iniciais contra o catálogo REAL de permissões
// (core.permissions). Definição inválida ou permissão inexistente lança AI_TOOL_DEFINITION_INVALID e o servidor não sobe.

const { ToolRegistry } = require('./ToolRegistry');
const { loadPermissionCatalog } = require('../readmodels/permissionCatalog.readmodel');
const { INITIAL_DEFINITIONS } = require('./definitions');
const { AGENT_TOOL_DEFINITIONS } = require('./definitions/agentTools');

let registro = null;

const loadPermissionCodes = async () => new Set(await loadPermissionCatalog());

/** Registro novo com as tools iniciais; `permissionCodes` opcional (sem ele lê core.permissions). */
async function buildDefaultRegistry(permissionCodes) {
  const registry = new ToolRegistry({ permissionCodes: permissionCodes || await loadPermissionCodes() });
  registry.registerAll([...INITIAL_DEFINITIONS, ...AGENT_TOOL_DEFINITIONS]);
  return registry;
}

let montagem = null;

/** Monta (uma vez) o registro do processo; pedidos simultâneos esperam a mesma montagem (ela lê o catálogo de permissões no banco). `force` refaz. */
async function initToolRegistry({ force = false, permissionCodes } = {}) {
  if (registro && !force) return registro;
  if (!montagem || force) {
    montagem = buildDefaultRegistry(permissionCodes).then((novo) => { registro = novo; return novo; }).finally(() => { montagem = null; });
  }
  return montagem;
}

function getToolRegistry() {
  if (!registro) throw new Error('ToolRegistry não inicializado: chame initToolRegistry() no boot.');
  return registro;
}

module.exports = { initToolRegistry, getToolRegistry, buildDefaultRegistry, loadPermissionCodes };
