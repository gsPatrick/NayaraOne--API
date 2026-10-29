'use strict';

/**
 * M9-D632 / M9-D633 — definições, no Metric Registry, de todos os KPIs de Comercial e Imóveis (a soma dos pacotes) e a entrada completa de `publishMetric`.
 * O texto de cada indicador (15 campos do livro, M9-D603) fica no pacote da demanda dona: commercial.defs.visitsImoveis (M9-D632) e
 * commercial.defs.radarCorretores (M9-D633).
 */
const { readCommercialOwner } = require('../../read-models/comercialKpi.settings');
const { PACKS } = require('./commercial.packs');

const DEFINITIONS = Object.freeze(PACKS.flatMap((pack) => pack.definitions));

/** Entrada completa de `publishMetric` (escopo da empresa, para o owner seguir o parâmetro de cada empresa). */
async function publishInput(def, scope, transaction) {
  return {
    ...def, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', valueNature: 'ACTUAL', formulaId: def.metricCode,
    ownerRole: await readCommercialOwner(def.metricCode, scope, transaction),
  };
}

module.exports = { DEFINITIONS, publishInput };
