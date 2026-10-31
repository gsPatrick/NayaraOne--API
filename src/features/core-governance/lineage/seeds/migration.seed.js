'use strict';

// M9-D914 — área MIGRATION: o caminho de cada campo crítico do mapa de migração (docs/governance/migration-field-map.json) até as métricas da Torre e os relatórios da
// migração: campo do legado -> campo de domínio -> evento migration.batch.applied -> read model -> métrica ou exportação. Entra no registro único pelo carregador da M9-D810;
// mapa e registro divergentes reprovam o portão (GOV_LINEAGE_MAP_DRIFT).
const { NODE, AREA } = require('../lineage.constants');
const { fieldNodes, edge } = require('../kit/paths');
const { qualifiedColumnOf } = require('../kit/domain');
const catalog = require('../kit/migrationCatalog');
const { loadMap, sourceCode } = require('../kit/migrationMap');

function sourceNode(row) {
  const [, table, column] = sourceCode(row).split('.');
  return {
    nodeType: NODE.SOURCE_FIELD, code: sourceCode(row), ownerDomain: catalog.ENTITY_DOMAIN[row.entity], area: AREA.MIGRATION, criticality: 'CRITICAL',
    description: `Coluna ${column} da tabela ${table} do sistema antigo ${row.sourceSystem} (entidade ${row.entity}): o dado como o legado o guarda, antes da migração.`,
  };
}

function build() {
  const event = catalog.eventNode();
  const nodes = [event]; const edges = [];
  const readModels = Object.keys(catalog.READ_MODELS).map(catalog.readModelNode);
  nodes.push(...readModels);
  for (const model of readModels) edges.push(edge(event, model, 'o lote aplicado atualiza o registro e a Torre de controle'));
  for (const item of catalog.METRICS) { const metric = catalog.metricNode(item); nodes.push(metric); edges.push(edge(readModels.find((m) => m.code === catalog.READ_MODELS[item.readModel].code), metric, item.transformation)); }
  for (const item of catalog.EXPORTS) { const exported = catalog.exportNode(item); nodes.push(exported); edges.push(edge(readModels.find((m) => m.code === catalog.READ_MODELS[item.readModel].code), exported, item.transformation)); }
  for (const row of loadMap().filter((entry) => entry.critical)) {
    const column = qualifiedColumnOf(row.domainField);
    if (!column) throw new Error(`Semente de lineage (migração): o campo de domínio ${row.domainField} não existe nos modelos.`);
    const source = sourceNode(row);
    const { domain } = fieldNodes(column);
    nodes.push(source, domain);
    edges.push(edge(source, domain, 'campo do legado gravado no atributo do destino pelo aplicador'), edge(domain, event, 'gravado pelo lote aplicado'));
  }
  return { nodes, edges };
}

module.exports = { code: 'M9-D914-migration', build };
