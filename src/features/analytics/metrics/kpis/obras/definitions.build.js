'use strict';

/**
 * M9-D650 / M9-D651 — monta a definição de um KPI de Obras no Metric Registry a partir da linha da tabela de criticidade (M9-D712, dona de criticidade,
 * natureza, unidade, dimensões e política de atualização) e do texto do KPI (descrição, fórmula em palavras e regra de qualidade, escritos pela demanda dona).
 */
const { getCriticalityRow } = require('../../seed/criticality.table');

const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Obras (M9-D708): avanço, custo, atrasos, medições e não conformidades conforme o módulo de Obras';

/** texts: { código: { description, formulaSemantic, qualityRule } }. Devolve a lista congelada de definições na ordem dos textos. */
const buildDefinitions = (texts) => Object.freeze(Object.keys(texts).map((code) => {
  const row = getCriticalityRow(code);
  return Object.freeze({
    metricCode: code, name: row.name, formulaId: row.formulaId, valueNature: row.valueNature, unit: row.unit, criticality: row.criticality, dimensions: [...row.dimensions],
    sourceReadModel: row.sourceReadModel, refreshPolicy: { ...row.refreshPolicy }, domain: row.domain, description: texts[code].description, formulaSemantic: texts[code].formulaSemantic,
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: row.refreshPolicy.maxStalenessMinutes, ...texts[code].qualityRule },
  });
}));

module.exports = { buildDefinitions };
