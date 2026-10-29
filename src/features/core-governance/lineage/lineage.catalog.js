'use strict';

const { AREA, NODE } = require('./lineage.constants');
const { listCriticalityRows } = require('../../analytics/metrics/seed/criticality.table');

/**
 * Catálogo de indicadores do código que o lineage cobra: a tabela de criticidade do BI (M9-D712), onde cada entrada carrega `area`. Função pura (sem banco),
 * por isso o portão de CI a usa sem subir o aplicativo.
 */
const catalogEntries = () => listCriticalityRows().map((row) => ({ nodeType: 'METRIC', code: row.code, criticality: row.criticality, area: row.area }));

/** Aplica o parâmetro de KPIs críticos (lista de códigos, ou `null` = todos) aos KPIs EXECUTIVOS; as demais áreas obrigatórias nunca saem. */
function applyCriticalKpiList(entries, list) {
  if (!list) return entries;
  return entries.filter((entry) => entry.area !== AREA.EXEC_KPI || list.includes(entry.code));
}

/** O mesmo recorte no registro: o indicador executivo fora da lista não entra na cobrança nem pelo próprio nó. */
function scopeRegistry(registry, list) {
  if (!list) return registry;
  return { ...registry, nodes: registry.nodes.filter((node) => !(node.nodeType === NODE.METRIC && node.area === AREA.EXEC_KPI && !list.includes(node.code))) };
}

module.exports = { catalogEntries, applyCriticalKpiList, scopeRegistry };
