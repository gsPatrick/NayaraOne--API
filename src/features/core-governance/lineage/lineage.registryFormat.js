'use strict';

const { createHash } = require('node:crypto');
const { NODE_TYPES, layerIndex, nodeKey } = require('./lineage.constants');

/**
 * M9-D810 §3.5 — formato do arquivo versionado do registro (`docs/governance/lineage-registry.json`): puro, sem banco. Uma linha por nó e por aresta
 * (diffs legíveis), ordem determinística e nenhuma data. Quem gera é só o `scripts/syncLineageRegistry.js`; quem confere é ele e o portão da M9-D811.
 */
const NODE_FIELDS = ['nodeType', 'code', 'description', 'ownerDomain', 'criticality', 'area'];
const VERSION = 1;

const byLayerThenCode = (a, b) => layerIndex(a.nodeType) - layerIndex(b.nodeType) || a.nodeType.localeCompare(b.nodeType) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const edgeKey = (e) => `${nodeKey(e.from.nodeType, e.from.code)}>${nodeKey(e.to.nodeType, e.to.code)}`;

const cleanNode = (n) => Object.fromEntries(NODE_FIELDS.map((f) => [f, n[f]]));
const cleanEdge = (e) => ({ from: { nodeType: e.from.nodeType, code: e.from.code }, to: { nodeType: e.to.nodeType, code: e.to.code }, transformation: e.transformation || null });

function normalize(registry) {
  const nodes = registry.nodes.map(cleanNode).sort(byLayerThenCode);
  const edges = registry.edges.map(cleanEdge).sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0));
  return { nodes, edges };
}

const hashOf = (registry) => createHash('sha256').update(JSON.stringify(normalize(registry))).digest('hex');

/** Texto do arquivo: cabeçalho, hash do conteúdo, um nó ou aresta por linha, quebra de linha final. */
function serializeRegistry(registry) {
  const { nodes, edges } = normalize(registry);
  const lines = (list) => list.map((item, i) => `    ${JSON.stringify(item)}${i < list.length - 1 ? ',' : ''}`).join('\n');
  return `{\n  "version": ${VERSION},\n  "seedHash": ${JSON.stringify(hashOf({ nodes, edges }))},\n  "nodes": [\n${lines(nodes)}\n  ],\n  "edges": [\n${lines(edges)}\n  ]\n}\n`;
}

/** Valida o formato lido do arquivo; devolve o motivo (texto) ou null quando está íntegro. */
function registryProblem(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'o arquivo não é um objeto';
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return 'faltam as listas nodes e edges';
  const ref = (r) => r && typeof r === 'object' && NODE_TYPES.includes(r.nodeType) && typeof r.code === 'string' && r.code;
  for (const node of data.nodes) if (!ref(node)) return 'nó com tipo ou código inválido';
  for (const edge of data.edges) if (!edge || !ref(edge.from) || !ref(edge.to)) return 'aresta com referência inválida';
  return null;
}

/** Diferenças entre dois textos do arquivo (lista de frases; vazia quando iguais). Texto ilegível conta como diferença. */
function diffRegistryFiles(a, b) {
  if (a === b) return [];
  let left; let right;
  try { left = normalize(JSON.parse(a)); right = normalize(JSON.parse(b)); } catch (_err) { return ['arquivo ilegível']; }
  const out = [];
  const compare = (label, listA, listB, keyOf) => {
    const mapA = new Map(listA.map((i) => [keyOf(i), JSON.stringify(i)])); const mapB = new Map(listB.map((i) => [keyOf(i), JSON.stringify(i)]));
    for (const [key, value] of mapA) { if (!mapB.has(key)) out.push(`${label} só no primeiro: ${key}`); else if (mapB.get(key) !== value) out.push(`${label} diferente: ${key}`); }
    for (const key of mapB.keys()) if (!mapA.has(key)) out.push(`${label} só no segundo: ${key}`);
  };
  compare('nó', left.nodes, right.nodes, (n) => nodeKey(n.nodeType, n.code));
  compare('aresta', left.edges, right.edges, edgeKey);
  return out.length ? out : ['formato ou cabeçalho diferente'];
}

module.exports = { serializeRegistry, registryProblem, diffRegistryFiles, normalize, hashOf, VERSION };
