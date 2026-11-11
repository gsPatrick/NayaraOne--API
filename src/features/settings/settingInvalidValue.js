'use strict';

const AppError = require('../../utils/AppError');

/**
 * Recusa de valor numérico fora do tipo ou da faixa de um parâmetro (validateAgainstSchema, settings.service.js).
 * Chave com `label` no dicionário (ex.: os parâmetros do antifraude, DEC-007/DI-DEC007-2) recebe a frase clara com o rótulo do catálogo e a faixa
 * ("deve ser um número inteiro de 1 a 365"), e o status do dono (`invalidStatus: 422`, valor bem formado mas fora da regra). Sem `label`, a frase e o
 * 400 de antes não mudam. O código é sempre SETTING_INVALID_VALUE.
 */
const BRL = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function rangeText(spec) {
  const kind = spec.type === 'integer' ? 'um número inteiro' : 'um número';
  if (spec.min !== undefined && spec.max !== undefined) return `${kind} de ${BRL.format(spec.min)} a ${BRL.format(spec.max)}`;
  if (spec.min !== undefined) return `${kind} a partir de ${BRL.format(spec.min)}`;
  if (spec.max !== undefined) return `${kind} até ${BRL.format(spec.max)}`;
  return kind;
}

/** AppError da recusa. `message`: a frase genérica de antes, usada quando a chave não tem `label`. */
function invalidNumberValue(key, spec, value, message) {
  const make = spec.invalidStatus === 422 ? AppError.unprocessable : AppError.badRequest;
  if (!spec.label) return make(message, 'SETTING_INVALID_VALUE', { key, value });
  const extra = spec.rangeNote ? ` (${spec.rangeNote})` : '';
  return make(
    `"${spec.label}" deve ser ${rangeText(spec)}${extra}. O valor enviado (${JSON.stringify(value)}) foi recusado e nada foi gravado.`,
    'SETTING_INVALID_VALUE',
    { key, value, min: spec.min ?? null, max: spec.max ?? null }
  );
}

module.exports = { invalidNumberValue, rangeText };
