'use strict';

const { readHealthParams } = require('./healthParams');

/**
 * Leitura do SLO por criticidade para o BI (M9-D628): o BI não importa serviço de outro módulo, só repositório de leitura. Devolve o limite de erro de cada
 * criticidade do fornecedor: 100 menos o sucesso mínimo da meta `integration.slo.<CRITICIDADE>` (a mesma que o Bloco B julga). Criticidade desconhecida usa a MEDIUM.
 */
async function readSloTargets(ctx, transaction) {
  const { slo } = await readHealthParams(ctx, transaction);
  const errorLimitPct = (criticality) => {
    const target = slo[criticality] || slo.MEDIUM;
    return Math.round((100 - target.minSuccessRate) * 100) / 100;
  };
  return { slo, errorLimitPct };
}

module.exports = { readSloTargets };
