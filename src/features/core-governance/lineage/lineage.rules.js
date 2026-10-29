'use strict';

const errors = require('./lineage.errors');
const { MANDATORY_AREAS, AREAS, CRITICALITIES, NODE_TYPES, layerIndex } = require('./lineage.constants');

/** Aresta válida só entre camadas vizinhas, na ordem do livro: pular ou voltar é 422 GOV_LINEAGE_LAYER_INVALID. */
function assertEdgeLayers(fromType, toType) {
  const from = layerIndex(fromType);
  const to = layerIndex(toType);
  if (from < 0 || to < 0) throw errors.nodeTypeInvalid();
  if (to !== from + 1) throw errors.layerInvalid();
}

/**
 * Criticidade do nó (D810 §3.2): área obrigatória é sempre CRITICAL e não rebaixa (409); em OTHER vale o pedido (padrão NORMAL).
 * Valor fora de NORMAL/CRITICAL é 400.
 */
function resolveCriticality(area, requested) {
  if (requested !== undefined && requested !== null && requested !== '' && !CRITICALITIES.includes(requested)) throw errors.criticalityInvalid();
  if (MANDATORY_AREAS.includes(area)) {
    if (requested === 'NORMAL') throw errors.criticalityLocked();
    return 'CRITICAL';
  }
  return requested || 'NORMAL';
}

const assertNodeType = (nodeType) => { if (!NODE_TYPES.includes(nodeType)) throw errors.nodeTypeInvalid(); };
const assertArea = (area) => { if (!AREAS.includes(area)) throw errors.areaInvalid(); };

module.exports = { assertEdgeLayers, resolveCriticality, assertNodeType, assertArea };
