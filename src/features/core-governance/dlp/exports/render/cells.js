'use strict';

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Valor de uma célula como texto simples (datas em ISO, vazio para nulo). */
function plain(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Texto que começa com = + - @ TAB ou CR vira fórmula na planilha (CSV injection, OWASP): ganha apóstrofo. Coluna numérica com número válido não muda
 * (um valor negativo continua número).
 */
function safeText(value, numeric = false) {
  const text = plain(value);
  if (numeric && NUMBER.test(text)) return text;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

module.exports = { plain, safeText, NUMBER };
