'use strict';

const { CENTS_RE } = require('./bank.constants');

/**
 * Valor em centavos inteiros a partir de texto decimal ("1250.00") ou número com até 2 casas. Nada de ponto flutuante na comparação: "0.30000000000000004" e
 * notação científica são recusados (null). Valor ausente também é null.
 */
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const texto = String(value).trim().replace(',', '.');
  if (!CENTS_RE.test(texto)) return null;
  const negativo = texto.startsWith('-');
  const [inteiro, fracao = ''] = texto.replace('-', '').split('.');
  const centavos = Number(inteiro) * 100 + Number(`${fracao}00`.slice(0, 2));
  return negativo ? -centavos : centavos;
}

/** Texto decimal com 2 casas ("1250.00") a partir do mesmo tipo de entrada; null se o valor não for um decimal limpo. */
function toDecimal(value) {
  const c = toCents(value);
  if (c === null) return null;
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

module.exports = { toCents, toDecimal };
