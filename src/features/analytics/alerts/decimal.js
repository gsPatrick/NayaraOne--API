'use strict';

/**
 * M9-D691 (3.1 passo 3) — comparação do valor com o limite por aritmética decimal exata (BigInt em 6 casas), sem ponto flutuante: o valor do
 * snapshot vem como texto numeric(20,4) e o limite como número do JSON. Operadores do livro: LT, LTE, GT, GTE, EQ, NEQ.
 */
const SCALE = 6;
const TEXT_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** BigInt do número escalado em 10^6 (casas além da sexta são truncadas). */
function scaled(input) {
  const text = typeof input === 'number' ? (Number.isInteger(input) ? String(input) : input.toFixed(SCALE)) : String(input).trim();
  const m = TEXT_RE.exec(text);
  if (!m) throw new Error(`Número inválido na comparação do alerta: ${text}`);
  const frac = (m[3] || '').padEnd(SCALE, '0').slice(0, SCALE);
  const big = BigInt(m[2] + frac);
  return m[1] === '-' ? -big : big;
}

const OPERATORS = Object.freeze({
  LT: (a, b) => a < b,
  LTE: (a, b) => a <= b,
  GT: (a, b) => a > b,
  GTE: (a, b) => a >= b,
  EQ: (a, b) => a === b,
  NEQ: (a, b) => a !== b,
});

/** true se `value <operador> limit`. Operador desconhecido é erro (nunca "falso" em silêncio). */
function compareThreshold(value, operator, limit) {
  const fn = OPERATORS[operator];
  if (!fn) throw new Error(`Operador de limite inválido: ${operator}`);
  return fn(scaled(value), scaled(limit));
}

module.exports = { compareThreshold, scaled, OPERATORS: Object.keys(OPERATORS) };
