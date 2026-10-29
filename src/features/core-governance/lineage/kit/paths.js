'use strict';

const { NODE } = require('../lineage.constants');
const { fieldOwnership, eventOwnership, readModelOwnership, metricOwner } = require('./owners');
const { sourceFieldsOf } = require('./fields');
const { domainFieldOf } = require('./domain');

/**
 * M9-D810 §3.3 — monta os caminhos de lineage (campo de origem -> campo de domínio -> evento -> read model -> métrica) dos indicadores de uma área, a partir
 * do que o sistema já declara: a tabela de criticidade do BI (indicador, área, read model, fórmula), a especificação de origem (colunas), os modelos
 * (atributo do domínio) e o registro de read models (eventos que o atualizam). Nada é digitado à mão por indicador: indicador novo na tabela com área
 * obrigatória entra aqui sozinho, e o portão da M9-D811 exige que o arquivo do registro acompanhe.
 */
function context() {
  const { listCriticalityRows } = require('../../../analytics/metrics/seed/criticality.table');
  const { getSourceSpec } = require('../../../analytics/metrics/sourceRefs');
  require('../../../analytics');
  const { getReadModel } = require('../../../analytics/read-models/readModel.registry');
  return { listCriticalityRows, getSourceSpec, getReadModel };
}

const eventPrefix = (type) => String(type).split('.')[0];
const schemaOf = (qualifiedColumn) => qualifiedColumn.split('.')[0];

/** Nó de campo de origem e seu campo de domínio (definição só do campo: igual em qualquer semente que o use). */
function fieldNodes(qualifiedColumn) {
  const { ownerDomain, area } = fieldOwnership(qualifiedColumn);
  const [schema, table, column] = qualifiedColumn.split('.');
  const domainCode = domainFieldOf(qualifiedColumn);
  return {
    source: { nodeType: NODE.SOURCE_FIELD, code: qualifiedColumn, description: `Coluna ${column} da tabela ${schema}.${table}: o dado como é gravado no sistema.`, ownerDomain, area, criticality: 'CRITICAL' },
    domain: { nodeType: NODE.DOMAIN_FIELD, code: domainCode, description: `Atributo ${domainCode.split('.').slice(1).join('.')} da entidade de domínio (coluna ${column}).`, ownerDomain, area, criticality: 'CRITICAL' },
  };
}

function eventNode(type) {
  const { ownerDomain, area } = eventOwnership(type);
  return { nodeType: NODE.EVENT, code: type, description: `Evento ${type}: avisa o BI de que o dado mudou e dispara o recálculo do read model.`, ownerDomain, area, criticality: 'CRITICAL' };
}

function readModelNode(qualifiedTable) {
  const { ownerDomain, area } = readModelOwnership(qualifiedTable);
  return { nodeType: NODE.READ_MODEL, code: qualifiedTable, description: `Read model ${qualifiedTable}: números prontos do BI, recalculados do estado da fonte a cada evento e pela agenda.`, ownerDomain, area, criticality: 'CRITICAL' };
}

const edge = (from, to, transformation) => ({ from: { nodeType: from.nodeType, code: from.code }, to: { nodeType: to.nodeType, code: to.code }, transformation });

/** Eventos do read model que carregam o domínio do campo (mesmo prefixo do schema); sem nenhum assim, todos os que atualizam o read model. */
function eventsCarrying(qualifiedColumn, eventTypes) {
  const schema = schemaOf(qualifiedColumn);
  const prefixes = { real_estate: ['real_estate', 'property'], construction: ['construction', 'obra', 'project'] }[schema] || [schema];
  const own = eventTypes.filter((type) => prefixes.includes(eventPrefix(type)));
  return own.length ? own : eventTypes;
}

/** Nós e arestas dos indicadores das áreas pedidas (a área é o campo `area` da entrada na tabela de criticidade). */
function buildForAreas(areas) {
  const ctx = context();
  const nodes = new Map(); const edges = new Map();
  const addNode = (node) => nodes.set(`${node.nodeType}|${node.code}`, node);
  const addEdge = (from, to, transformation) => edges.set(`${from.nodeType}|${from.code}>${to.nodeType}|${to.code}`, edge(from, to, transformation));
  for (const row of ctx.listCriticalityRows().filter((r) => areas.includes(r.area))) {
    const model = ctx.getReadModel(row.sourceReadModel);
    if (!model || !model.eventTypes.length) throw new Error(`Semente de lineage: o read model ${row.sourceReadModel} do indicador ${row.code} não está registrado ou não tem eventos.`);
    const rm = readModelNode(`analytics.${row.sourceReadModel}`);
    const metric = { nodeType: NODE.METRIC, code: row.code, description: `${row.name} (${row.code}), versão vigente do registry de métricas do BI; classificação ${row.criticality} (${row.reason}).`, ownerDomain: metricOwner(row), area: row.area, criticality: 'CRITICAL' };
    addNode(rm); addNode(metric); addEdge(rm, metric, `fórmula ${row.formulaId}`);
    const events = model.eventTypes.map(eventNode);
    for (const event of events) { addNode(event); addEdge(event, rm, 'dispara o recálculo do estado completo da fonte'); }
    for (const column of sourceFieldsOf(row.code, ctx.getSourceSpec)) {
      const { source, domain } = fieldNodes(column);
      addNode(source); addNode(domain); addEdge(source, domain, 'coluna lida pelo atributo do modelo');
      for (const type of eventsCarrying(column, model.eventTypes)) addEdge(domain, eventNode(type), 'carregado pelo evento');
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

module.exports = { buildForAreas, fieldNodes, eventNode, readModelNode, edge, eventsCarrying };
