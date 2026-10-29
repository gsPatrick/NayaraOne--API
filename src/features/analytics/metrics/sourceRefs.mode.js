'use strict';

/**
 * M9-D611 (3.2) — modo de reconciliação do detalhe com o valor do KPI, derivado da unidade:
 *   SUM        BRL e BRL_PER_UNIT por soma: a soma do campo monetário das linhas do filtro é o valor;
 *   COUNT      COUNT: o número de linhas é o valor;
 *   RECOMPUTE  PERCENT, PP, SCORE, DAYS, HOURS, MINUTES, SECONDS, NUMBER (médias, taxas, tempos): refaz-se a fórmula do KPI sobre as linhas.
 * Função pura. Um BRL_PER_UNIT que não é soma (preço médio) declara `reconcileMode: 'RECOMPUTE'` na especificação de origem.
 */
const SUM_UNITS = Object.freeze(['BRL', 'BRL_PER_UNIT']);
const MODES = Object.freeze(['SUM', 'COUNT', 'RECOMPUTE']);

function reconcileModeForUnit(unit) {
  if (SUM_UNITS.includes(unit)) return 'SUM';
  if (unit === 'COUNT') return 'COUNT';
  return 'RECOMPUTE';
}

module.exports = { MODES, reconcileModeForUnit };
