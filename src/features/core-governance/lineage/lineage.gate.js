'use strict';

const { AREAS, AREA, NODE, MANDATORY_AREAS, nodeKey } = require('./lineage.constants');
const { computeCoverage } = require('./lineage.coverage');

/**
 * M9-D811 — regras do portão de CI, puras (o script só lê arquivos e imprime). Devolve { errors, critical, covered, uncovered }; cada erro é
 * `{ code, message }`. NÃO existe lista de isenção (regra 5): nada aqui lê exceção alguma.
 */
const AREA_MISSING = 'GOV_LINEAGE_AREA_MISSING';

/** Entradas do catálogo sem área válida (regra 4: "área obrigatória"). */
function areaProblems(catalog) {
  return catalog.filter((entry) => !AREAS.includes(entry.area)).map((entry) => ({ code: AREA_MISSING, message: `Informe a área da métrica ${entry.code}.` }));
}

/** Mapa de migração x registro (regra 6): o campo crítico do mapa precisa de SOURCE_FIELD, DOMAIN_FIELD e da aresta entre eles, e o registro MIGRATION não pode ter campo de origem fora do mapa. */
function mapProblems(registry, map) {
  const critical = map.filter((row) => row && row.critical !== false);
  const sourceCode = (row) => (String(row.sourceField).startsWith(`${row.sourceSystem}.`) ? String(row.sourceField) : `${row.sourceSystem}.${row.sourceField}`);
  const nodes = new Set(registry.nodes.map((n) => nodeKey(n.nodeType, n.code)));
  const edges = new Set(registry.edges.map((e) => `${nodeKey(e.from.nodeType, e.from.code)}>${nodeKey(e.to.nodeType, e.to.code)}`));
  const expected = new Set(critical.map((row) => nodeKey(NODE.SOURCE_FIELD, sourceCode(row))));
  const drift = [];
  for (const row of critical) {
    const from = nodeKey(NODE.SOURCE_FIELD, sourceCode(row));
    const to = nodeKey(NODE.DOMAIN_FIELD, row.domainField);
    if (!nodes.has(from) || !nodes.has(to) || !edges.has(`${from}>${to}`)) drift.push(from);
  }
  for (const node of registry.nodes) if (node.nodeType === NODE.SOURCE_FIELD && node.area === AREA.MIGRATION && !expected.has(nodeKey(node.nodeType, node.code))) drift.push(nodeKey(node.nodeType, node.code));
  return drift.length ? [{ code: 'GOV_LINEAGE_MAP_DRIFT', message: 'O mapa de migração e o lineage divergem.', fields: [...new Set(drift)] }] : [];
}

function evaluate({ registry, catalog, map = null }) {
  const problems = [...areaProblems(catalog)];
  const coverage = computeCoverage(registry, catalog.filter((entry) => AREAS.includes(entry.area)));
  for (const item of coverage.uncovered) problems.push({ code: 'GOV_LINEAGE_UNCOVERED', message: `KPI crítico sem lineage: ${item.code}.`, area: item.area });
  for (const node of coverage.incomplete) {
    const what = node.missing.includes('ownerDomain') ? 'responsável' : 'descrição';
    problems.push({ code: 'GOV_LINEAGE_NODE_INCOMPLETE', message: `Nó de lineage sem ${what}: ${node.code}.`, missing: node.missing });
  }
  if (map) problems.push(...mapProblems(registry, map));
  return { errors: problems, critical: coverage.critical.length, covered: coverage.covered.length, uncovered: coverage.uncovered, percent: coverage.percent };
}

module.exports = { evaluate, areaProblems, mapProblems, MANDATORY_AREAS };
