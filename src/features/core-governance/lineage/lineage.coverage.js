'use strict';

const { LAYERS, MANDATORY_AREAS, TARGET_TYPES, layerIndex, nodeKey, blank } = require('./lineage.constants');

/**
 * M9-D810 §3.2 — cobertura de lineage. Função pura sobre o registro { nodes, edges } (nós `{nodeType, code, description, ownerDomain, criticality, area}`,
 * arestas `{from:{nodeType,code}, to:{nodeType,code}}`). Um indicador ou exportação CRÍTICO está COBERTO quando existe ao menos um caminho completo
 * (campo de origem até ele, pelas cinco camadas) em que todo nó tem responsável e descrição; do contrário está DESCOBERTO.
 * Crítico = criticidade CRITICAL ou área obrigatória (regra do livro: não se rebaixa).
 */
const missingFields = (node) => ['description', 'ownerDomain'].filter((field) => blank(node[field]));
const isCritical = (item) => item.criticality === 'CRITICAL' || MANDATORY_AREAS.includes(item.area);

/** Nós do registro com descrição ou responsável em branco (o "documentation check" do portão). */
function incompleteNodes(nodes) {
  return nodes.map((node) => ({ nodeType: node.nodeType, code: node.code, missing: missingFields(node) })).filter((item) => item.missing.length);
}

/** Conjunto das chaves dos nós com caminho completo da origem até eles (memoizado camada a camada). */
function completeNodes(nodes, edges) {
  const byKey = new Map(nodes.map((node) => [nodeKey(node.nodeType, node.code), node]));
  const incoming = new Map();
  for (const edge of edges) {
    const key = nodeKey(edge.to.nodeType, edge.to.code);
    if (!incoming.has(key)) incoming.set(key, []);
    incoming.get(key).push(nodeKey(edge.from.nodeType, edge.from.code));
  }
  const memo = new Map();
  const complete = (key) => {
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false); // protege contra ciclo (a ordem das camadas já impede, o arquivo pode vir adulterado)
    const node = byKey.get(key);
    let ok = false;
    if (node && !missingFields(node).length) {
      const layer = layerIndex(node.nodeType);
      ok = layer === 0 || (incoming.get(key) || []).some((fromKey) => byKey.has(fromKey) && layerIndex(byKey.get(fromKey).nodeType) === layer - 1 && complete(fromKey));
    }
    memo.set(key, ok);
    return ok;
  };
  return { complete, byKey };
}

/**
 * `targets`: indicadores do catálogo `{code, criticality, area, nodeType?='METRIC'}`, na ordem do catálogo. Entram também os nós METRIC/EXPORT críticos do
 * próprio registro (ordenados por código). Devolve { critical, covered, uncovered, percent, incomplete } (listas de códigos, `uncovered` com tipo e área).
 */
function computeCoverage(registry, targets = []) {
  const { nodes, edges } = registry;
  const { complete } = completeNodes(nodes, edges);
  const wanted = new Map();
  for (const target of targets.filter(isCritical)) wanted.set(nodeKey(target.nodeType || 'METRIC', target.code), { nodeType: target.nodeType || 'METRIC', code: target.code, area: target.area });
  const own = nodes.filter((node) => TARGET_TYPES.includes(node.nodeType) && isCritical(node)).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const node of own) if (!wanted.has(nodeKey(node.nodeType, node.code))) wanted.set(nodeKey(node.nodeType, node.code), { nodeType: node.nodeType, code: node.code, area: node.area });
  const critical = []; const covered = []; const uncovered = [];
  for (const [key, item] of wanted) {
    critical.push(item.code);
    if (complete(key)) covered.push(item.code); else uncovered.push({ nodeType: item.nodeType, code: item.code, area: item.area });
  }
  const percent = critical.length ? Math.round((covered.length * 1000) / critical.length) / 10 : 100;
  return { critical, covered, uncovered, percent, incomplete: incompleteNodes(nodes) };
}

module.exports = { computeCoverage, incompleteNodes, completeNodes, isCritical, LAYERS };
