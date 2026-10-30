'use strict';

const E = require('./flags.errors');

/**
 * Confere o valor contra o tipo da chave (M9-D870 §3.1; erro 422 GOV_FLAG_VALUE_INVALID). Devolve o valor normalizado.
 * BOOLEAN: verdadeiro/falso; INTEGER: inteiro seguro; DECIMAL: número finito; STRING: texto; ENUM: um dos valores permitidos; JSON: objeto ou lista.
 * `max` (parâmetro governanca.flags.valor_max_caracteres) limita o tamanho do texto e do JSON.
 */
function checkValue(valueType, value, { allowedValues = null, max }) {
  const bad = (reason) => E.valueInvalid({ valueType, reason });
  switch (valueType) {
    case 'BOOLEAN':
      if (typeof value !== 'boolean') throw bad('esperado verdadeiro ou falso');
      return value;
    case 'INTEGER':
      if (!Number.isSafeInteger(value)) throw bad('esperado número inteiro');
      return value;
    case 'DECIMAL':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('esperado número');
      return value;
    case 'STRING':
      if (typeof value !== 'string') throw bad('esperado texto');
      if (value.length > max) throw bad(`texto acima de ${max} caracteres`);
      return value;
    case 'ENUM':
      if (typeof value !== 'string' || !Array.isArray(allowedValues) || !allowedValues.includes(value)) throw bad('valor fora da lista permitida');
      return value;
    case 'JSON':
      if (value === null || typeof value !== 'object') throw bad('esperado objeto ou lista');
      if (JSON.stringify(value).length > max) throw bad(`JSON acima de ${max} caracteres`);
      return value;
    default:
      throw bad('tipo desconhecido');
  }
}

/** Lista de valores permitidos de um ENUM: texto não vazio, sem repetição. */
function checkAllowed(valueType, allowedValues) {
  if (valueType !== 'ENUM') return null;
  const ok = Array.isArray(allowedValues) && allowedValues.length > 0 && allowedValues.every((v) => typeof v === 'string' && v.trim() !== '') && new Set(allowedValues).size === allowedValues.length;
  if (!ok) throw E.inputInvalid('Informe a lista de valores permitidos (allowedValues) do tipo ENUM.', { field: 'allowedValues' });
  return allowedValues;
}

module.exports = { checkValue, checkAllowed };
