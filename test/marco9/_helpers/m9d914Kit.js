'use strict';

// Apoio dos testes M9-D914 (não é teste): registro e mapa reais, caminhos e o portão de CI rodando sobre cópias alteradas.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_FILE = path.join(ROOT, 'docs/governance/lineage-registry.json');
const MAP_FILE = path.join(ROOT, 'docs/governance/migration-field-map.json');
const SCRIPT = path.join(ROOT, 'scripts/checkLineageCoverage.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-d914-'));
let seq = 0;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const write = (data) => { seq += 1; const file = path.join(dir, `f${seq}.json`); fs.writeFileSync(file, JSON.stringify(data)); return file; };
const key = (ref) => `${ref.nodeType}|${ref.code}`;

/**
 * Primeiro caminho do nó até uma MÉTRICA ou EXPORTAÇÃO, camada a camada. `via` obriga a passar pelo evento de código dado (o campo de domínio também alimenta outros eventos de
 * outras áreas); `to` obriga a terminar no código dado.
 */
function pathFrom(registry, nodeType, code, { via = null, to = null } = {}) {
  const out = new Map();
  for (const edge of registry.edges) out.set(key(edge.from), [...(out.get(key(edge.from)) || []), edge.to]);
  const walk = (ref, trail) => {
    if (ref.nodeType === 'EVENT' && via && ref.code !== via) return null;
    const next = [...trail, ref];
    if (ref.nodeType === 'METRIC' || ref.nodeType === 'EXPORT') return !to || ref.code === to ? next : null;
    for (const target of out.get(key(ref)) || []) { const found = walk(target, next); if (found) return found; }
    return null;
  };
  return walk({ nodeType, code }, []);
}

/** Roda o portão (exit + saída) sobre o registro e o mapa dados (objetos); o catálogo é o do código. */
function gate(registry, map, extra = []) {
  const args = [SCRIPT, '--registry', write(registry), '--map', map === null ? path.join(dir, 'sem-mapa.json') : write(map), ...extra];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

module.exports = { ROOT, REGISTRY_FILE, MAP_FILE, readJson, clone, pathFrom, gate, key };
