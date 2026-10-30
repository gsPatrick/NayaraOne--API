'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ENTRIES, KINDS } = require('./deterministic.catalog');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/** Códigos dos agentes do sistema: uma pasta `nay_<nome>` em agents/ é o agente `NAY_<NOME>`. */
function systemAgentCodes() {
  return fs.readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && /^nay_[a-z]+$/.test(d.name)).map((d) => d.name.toUpperCase());
}

/**
 * As funções com IA do ERP que NÃO declaram o caminho determinístico (M9-D228 critério 2): toda tool do registro, todo agente do sistema e a busca do RAG. Lista vazia = cobertura completa.
 * `toolNames`: nomes do ToolRegistry (quem chama passa o registro montado).
 */
function functionsWithoutDeterministicPath(toolNames) {
  const exigidas = [...toolNames.map((n) => `tool:${n}`), ...systemAgentCodes().map((c) => `agent:${c}`), 'rag.search'];
  return exigidas.filter((id) => !ENTRIES[id] || !KINDS.includes(ENTRIES[id].kind) || !String(ENTRIES[id].equivalent || '').trim());
}

/** Entradas do catálogo que apontam para função que não existe mais (catálogo velho). */
function staleEntries(toolNames) {
  const tools = new Set(toolNames.map((n) => `tool:${n}`));
  const agents = new Set(systemAgentCodes().map((c) => `agent:${c}`));
  return Object.keys(ENTRIES).filter((id) => (id.startsWith('tool:') && !tools.has(id)) || (id.startsWith('agent:') && !agents.has(id)));
}

module.exports = { functionsWithoutDeterministicPath, staleEntries, systemAgentCodes };
