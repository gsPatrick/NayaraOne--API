'use strict';

const AppError = require('../../utils/AppError');

/**
 * Texto obrigatorio dos prazos juridicos (auditoria da cliente, Marco 5, item 3).
 *
 * Caracteres que nao sao "texto de verdade": controles (Cc), formatacao/invisiveis (Cf: U+200B,
 * U+200C-200F, U+00AD, U+2060-2064, U+FEFF, U+180E, U+202A-202E...), separadores/espacos
 * Unicode (Z: U+00A0, U+2000-200A, U+3000...), preenchedores que renderizam em branco
 * (U+034F, U+115F, U+1160, U+3164, U+FFA0) e seletores de variacao (U+FE00-FE0F).
 * Tambem entram os que renderizam em branco fora de Cc/Cf/Z: Braille em branco (U+2800), fillers
 * Hangul (U+115F, U+1160, U+3164, U+FFA0), vogais Khmer inerentes (U+17B4-17B5), marca de letra
 * arabe (U+061C), U+1D159 (nota musical nula), alem de tudo que o Unicode marca como
 * Default_Ignorable_Code_Point (tags U+E0000-E007F, seletores U+E0100-E01EF, U+180B-180F...).
 */
const INVISIBLE_CLASS =
  '[\\p{Cc}\\p{Cf}\\p{Z}\\p{Variation_Selector}\\p{Default_Ignorable_Code_Point}' +
  '\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u2800\\u3164\\uFFA0\\u{1D159}\\u{1D173}-\\u{1D17A}]';
const INVISIBLE_ALL = new RegExp(INVISIBLE_CLASS, 'gu');
const INVISIBLE_EDGES = new RegExp(`^${INVISIBLE_CLASS}+|${INVISIBLE_CLASS}+$`, 'gu');

function assertString(value, field) {
  if (typeof value !== 'string') {
    throw AppError.badRequest(`O campo "${field}" deve ser um texto.`, 'LEGAL_DEADLINE_VALIDATION');
  }
}

/** true se, tirados espacos e invisiveis, sobra algum caractere visivel. */
function hasVisibleText(value) {
  return typeof value === 'string' && value.replace(INVISIBLE_ALL, '').length > 0;
}

/** Tira espacos/invisiveis das pontas; vazio vira null. Nao-texto (0, false, {}, []) e recusado (400). */
function normalizeOptionalText(value, field) {
  if (value === undefined || value === null) return null;
  assertString(value, field);
  if (!hasVisibleText(value)) return null;
  return value.replace(INVISIBLE_EDGES, '');
}

/** Texto obrigatorio: precisa ser string com caractere visivel e respeitar o tamanho maximo. */
function requireText(value, field, { max } = {}) {
  assertString(value, field);
  const text = normalizeOptionalText(value, field);
  if (!text) {
    throw AppError.badRequest(`O campo "${field}" é obrigatório e não pode ser vazio.`, 'LEGAL_DEADLINE_VALIDATION');
  }
  if (max && text.length > max) {
    throw AppError.badRequest(`O campo "${field}" aceita no máximo ${max} caracteres.`, 'LEGAL_DEADLINE_VALIDATION');
  }
  return text;
}

module.exports = { hasVisibleText, normalizeOptionalText, requireText };
