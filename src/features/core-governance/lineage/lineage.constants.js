'use strict';

/**
 * M9-D810 — vocabulário do registro de lineage. As camadas, na ordem do livro (Caderno §3): campo de origem -> campo de domínio -> evento ->
 * read model -> métrica ou exportação (as duas últimas dividem a última camada). As seis áreas obrigatórias são as do livro ("dinheiro,
 * contratos, comissões, DIMOB, KPIs executivos e migração"); OTHER é qualquer outra e é a única que pode ser NORMAL.
 */
const LAYERS = Object.freeze(['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', Object.freeze(['METRIC', 'EXPORT'])]);
const NODE_TYPES = Object.freeze(LAYERS.flat());
const TARGET_TYPES = Object.freeze(['METRIC', 'EXPORT']);
const MANDATORY_AREAS = Object.freeze(['MONEY', 'CONTRACT', 'COMMISSION', 'DIMOB', 'EXEC_KPI', 'MIGRATION']);
const AREAS = Object.freeze([...MANDATORY_AREAS, 'OTHER']);
// Nomes dos tipos de nó e das áreas como constantes, para o código não repetir texto solto (e o varredor de códigos de erro do bloco não os confundir com erro).
const NODE = Object.freeze({ SOURCE_FIELD: 'SOURCE_FIELD', DOMAIN_FIELD: 'DOMAIN_FIELD', EVENT: 'EVENT', READ_MODEL: 'READ_MODEL', METRIC: 'METRIC', EXPORT: 'EXPORT' });
const AREA = Object.freeze({ MONEY: 'MONEY', CONTRACT: 'CONTRACT', COMMISSION: 'COMMISSION', DIMOB: 'DIMOB', EXEC_KPI: 'EXEC_KPI', MIGRATION: 'MIGRATION', OTHER: 'OTHER' });
const CRITICALITIES = Object.freeze(['NORMAL', 'CRITICAL']);
const SOURCES = Object.freeze({ SEED: 'SEED', API: 'API' });

/** Índice da camada de um tipo de nó (-1 quando o tipo não existe). */
function layerIndex(nodeType) {
  return LAYERS.findIndex((layer) => (Array.isArray(layer) ? layer.includes(nodeType) : layer === nodeType));
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const nodeKey = (nodeType, code) => `${nodeType}|${code}`;
const blank = (value) => typeof value !== 'string' || !value.trim();

module.exports = { NODE, AREA, LAYERS, NODE_TYPES, TARGET_TYPES, MANDATORY_AREAS, AREAS, CRITICALITIES, SOURCES, CODE_PATTERN, layerIndex, nodeKey, blank };
