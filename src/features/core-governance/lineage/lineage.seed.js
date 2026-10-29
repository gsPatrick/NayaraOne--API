'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const errors = require('./lineage.errors');
const rules = require('./lineage.rules');
const repository = require('./lineage.repository');
const { parseNode, parseRef } = require('./lineage.input');
const { nodeKey, layerIndex } = require('./lineage.constants');

/**
 * M9-D810 §3.3 e §3.5 — semente do registro. Cada demanda que cria um KPI, uma exportação ou uma entidade migrada entrega um arquivo
 * `lineage/seeds/*.seed.js` com `{ code, build() -> { nodes, edges } }`; este carregador junta todos (nó repetido com a MESMA definição vale uma vez, com definição
 * diferente é GOV_LINEAGE_SEED_CONFLICT) e o aplica ao grupo. Nenhuma demanda cria outro arquivo, outro gerador ou outro formato: o arquivo versionado sai de
 * `scripts/syncLineageRegistry.js`. A semente só atualiza o que ainda é dela: nó editado pela API (`source = 'API'`) nunca é sobrescrito.
 */
const DEFAULT_DIR = path.join(__dirname, 'seeds');
const SEED_FILE = /\.seed\.js$/;

const sameDefinition = (a, b) => ['description', 'ownerDomain', 'criticality', 'area'].every((field) => a[field] === b[field]);
const byOrder = (a, b) => layerIndex(a.nodeType) - layerIndex(b.nodeType) || a.nodeType.localeCompare(b.nodeType) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** Lê e valida as sementes da pasta; devolve { nodes, edges, hash } ordenados e sem repetição. */
function loadSeeds(dir = DEFAULT_DIR) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => SEED_FILE.test(name)).sort() : [];
  const nodes = new Map();
  const edges = new Map();
  for (const file of files) {
    const seed = require(path.join(dir, file));
    if (!seed || typeof seed.code !== 'string' || typeof seed.build !== 'function') throw errors.seedInvalid({ file });
    const built = seed.build() || {};
    for (const raw of built.nodes || []) {
      const node = parseNode(raw);
      const key = nodeKey(node.nodeType, node.code);
      if (nodes.has(key) && !sameDefinition(nodes.get(key), node)) throw errors.seedConflict({ node: key, seed: seed.code });
      nodes.set(key, node);
    }
    for (const raw of built.edges || []) {
      const from = parseRef(raw.from);
      const to = parseRef(raw.to);
      rules.assertEdgeLayers(from.nodeType, to.nodeType);
      edges.set(`${nodeKey(from.nodeType, from.code)}>${nodeKey(to.nodeType, to.code)}`, { from, to, transformation: raw.transformation || null });
    }
  }
  for (const edge of edges.values()) {
    if (!nodes.has(nodeKey(edge.from.nodeType, edge.from.code)) || !nodes.has(nodeKey(edge.to.nodeType, edge.to.code))) throw errors.seedInvalid({ edge: `${edge.from.code} > ${edge.to.code}` });
  }
  const sortedNodes = [...nodes.values()].sort(byOrder);
  const sortedEdges = [...edges.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, edge]) => edge);
  const hash = createHash('sha256').update(JSON.stringify({ nodes: sortedNodes, edges: sortedEdges })).digest('hex');
  return { nodes: sortedNodes, edges: sortedEdges, hash };
}

/** Aplica ao grupo da sessão o conjunto de sementes, se ainda não foi aplicado (hash guardado em lineage_seed_state). */
async function ensureSeeded(tenant, transaction, { dir } = {}) {
  const seeds = loadSeeds(dir);
  if ((await repository.getSeedHash(tenant.groupId, transaction)) === seeds.hash) return { applied: false, hash: seeds.hash, nodes: seeds.nodes.length, edges: seeds.edges.length };
  await repository.upsertSeedNodes(tenant.groupId, seeds.nodes, transaction);
  await repository.upsertSeedEdges(tenant.groupId, seeds.edges, transaction);
  await repository.setSeedHash(tenant.groupId, seeds.hash, transaction);
  return { applied: true, hash: seeds.hash, nodes: seeds.nodes.length, edges: seeds.edges.length };
}

module.exports = { loadSeeds, ensureSeeded, DEFAULT_DIR };
