'use strict';

const { NODE, AREA } = require('../lineage.constants');
const { EVENT_CODE, OWNER, READ_MODELS, METRICS, EXPORTS, ENTITY_DOMAIN } = require('./migration.constants');

/** Nós e entradas de catálogo da migração (M9-D914). Os códigos e textos estão em `migration.constants.js`. */
const base = { ownerDomain: OWNER, area: AREA.MIGRATION, criticality: 'CRITICAL' };
const eventNode = () => ({ ...base, nodeType: NODE.EVENT, code: EVENT_CODE, description: 'Registro de auditoria migration.batch.applied: gravado pelo aplicador da carga delta (M9-D900) a cada lote aplicado, com origem, entidade, posições, linhas e raiz de integridade.' });
const readModelNode = (key) => ({ ...base, nodeType: NODE.READ_MODEL, ...READ_MODELS[key] });
const metricNode = (item) => ({ ...base, nodeType: NODE.METRIC, code: item.code, description: item.description });
const exportNode = (item) => ({ ...base, nodeType: NODE.EXPORT, code: item.code, description: item.description });

/** Entradas do catálogo que o portão de CI cobra (M9-D811): cada métrica e relatório da migração é crítico e precisa de caminho completo. */
const catalogEntries = () => [
  ...METRICS.map((item) => ({ nodeType: NODE.METRIC, code: item.code, criticality: 'CRITICAL', area: AREA.MIGRATION })),
  ...EXPORTS.map((item) => ({ nodeType: NODE.EXPORT, code: item.code, criticality: 'CRITICAL', area: AREA.MIGRATION })),
];

module.exports = { EVENT_CODE, OWNER, READ_MODELS, METRICS, EXPORTS, ENTITY_DOMAIN, eventNode, readModelNode, metricNode, exportNode, catalogEntries };
