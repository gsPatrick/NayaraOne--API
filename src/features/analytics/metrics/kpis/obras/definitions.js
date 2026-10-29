'use strict';

/**
 * M9-D650 / M9-D651 — definição, no Metric Registry, dos KPIs de Obras do BI. Os 15 campos do livro (M9-D603): fonte (read model de Obras da M9-D618),
 * fórmula versionada no código (formulas/obra*.js, id igual ao código do indicador, como manda a tabela de criticidade da M9-D712), dimensões, unidade,
 * owner (parâmetro analytics.owner.<código>), política de atualização, natureza do valor (M9-D610) e regra de qualidade. Versão 1. Os textos de cada
 * grupo de KPIs moram no arquivo da demanda dona (definitions.custo.js, definitions.operacao.js).
 */
const { readObraOwner } = require('../../../read-models/obraKpi.settings');

const KPI_DEFINITIONS = Object.freeze([
  ...require('./definitions.custo').DEFINITIONS, // M9-D650
  ...require('./definitions.operacao').DEFINITIONS, // M9-D651
]);

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return { ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', ownerRole: await readObraOwner(def.metricCode, scope, transaction) };
}

module.exports = { KPI_DEFINITIONS, publishInput };
