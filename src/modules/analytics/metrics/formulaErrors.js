'use strict';

/**
 * M9-D605 — erros das fórmulas. Mora em metrics/ (e não em formulas/) porque a fórmula é pura e só importa de metrics/; quem usa
 * AppError é este arquivo.
 */
const AppError = require('../../../utils/AppError');

function inputInvalid() {
  return AppError.unprocessable('Dado de origem inválido para o cálculo.', 'ANALYTICS_FORMULA_INPUT_INVALID');
}

function notDeterministic(detail) {
  return AppError.internal('A fórmula não é determinística e não pode ser publicada.', 'ANALYTICS_FORMULA_NOT_DETERMINISTIC', detail ? { motivo: detail } : undefined);
}

module.exports = { inputInvalid, notDeterministic };
