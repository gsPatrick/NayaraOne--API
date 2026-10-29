'use strict';

/**
 * M9-D610 (BI-006, 3.1 a 3.3) — natureza do valor. Enumeração fechada (ACTUAL, PLANNED, ESTIMATED, PROJECTED) com o rótulo em português
 * que a API devolve junto de `valueNature`, e a regra de publicação: fórmula que lê campos de naturezas diferentes precisa declarar
 * `mixesNatures: true` e o registry recusa essa declaração em KPI monetário (422 ANALYTICS_FORMULA_MIXES_NATURES).
 * A fórmula pode ainda declarar `inputNatures` (naturezas dos campos que lê): se tiver mais de uma sem `mixesNatures: true`, ou
 * se a única natureza lida diferir da natureza da métrica, a publicação também é recusada.
 */
const AppError = require('../../../utils/AppError');

const VALUE_NATURES = Object.freeze(['ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED']);
const NATURE_LABELS = Object.freeze({ ACTUAL: 'Realizado', PLANNED: 'Previsto', ESTIMATED: 'Estimado', PROJECTED: 'Projetado' });
const CODE = 'ANALYTICS_FORMULA_MIXES_NATURES';

const isMonetary = (unit) => typeof unit === 'string' && unit.startsWith('BRL');
const natureLabel = (nature) => NATURE_LABELS[nature] || null;

function refuse(message, details) {
  return AppError.unprocessable(message, CODE, details);
}

/** Lança 422 se a fórmula mistura naturezas de forma não permitida. `input` = { unit, valueNature } da versão a publicar. */
function assertNaturesNotMixed(formula, input) {
  const declared = Array.isArray(formula.inputNatures) ? [...new Set(formula.inputNatures)] : [];
  const mixes = formula.mixesNatures === true || declared.length > 1;
  if (mixes && isMonetary(input.unit)) {
    throw refuse('A fórmula mistura valores previstos e realizados.', { formulaId: formula.id, unit: input.unit, inputNatures: declared });
  }
  if (declared.length > 1 && formula.mixesNatures !== true) {
    throw refuse('A fórmula lê naturezas diferentes e precisa declarar mixesNatures.', { formulaId: formula.id, inputNatures: declared });
  }
  if (declared.length === 1 && declared[0] !== input.valueNature) {
    throw refuse('A fórmula lê uma natureza diferente da natureza declarada pela métrica.', { formulaId: formula.id, inputNatures: declared, valueNature: input.valueNature });
  }
}

module.exports = { VALUE_NATURES, NATURE_LABELS, natureLabel, isMonetary, assertNaturesNotMixed };
