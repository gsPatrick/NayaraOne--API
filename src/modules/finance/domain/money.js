'use strict';

/**
 * Dinheiro em decimal exato (Caderno M4 FIN-008 "Moeda usa numeric/decimal"; Guia §18 "Não usar float para dinheiro").
 * Regra pura, sem banco e sem HTTP. Todo valor monetário entra como texto decimal (o que o Postgres devolve para numeric) ou número com até 2 casas, vira
 * CENTAVOS INTEIROS pela leitura do texto (nunca multiplicando um float) e as contas com percentual são feitas em BigInt, com UM modo de arredondamento
 * declarado. DI-M4CC-1 (Maturacao/demandas/decisoes-de-implementacao.md): o livro não define o arredondamento; o modo vem da regra de comissão vigente
 * (REG-FIN-001, campo `rounding`), padrão HALF_UP — meio centavo sempre para longe do zero.
 */

const ROUNDING_MODES = Object.freeze(['HALF_UP', 'HALF_EVEN']);
const DEFAULT_ROUNDING_MODE = 'HALF_UP';

const DECIMAL_TEXT = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Lê um decimal (texto ou número finito) como inteiro escalado exato.
 * @param {string|number|bigint} value
 * @returns {{ units: bigint, scale: number }} valor = units / 10^scale
 */
function parseDecimal(value) {
  if (typeof value === 'bigint') return { units: value, scale: 0 };
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Valor decimal inválido: ${value}`);
  // Number -> texto: String(0.29) é "0.29" (a representação mais curta que volta ao mesmo número), nunca 0.28999...
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const [mantissa, expText] = text.split(/e/i);
  const m = DECIMAL_TEXT.exec(mantissa);
  if (!m || (expText !== undefined && !/^[+-]?\d+$/.test(expText))) throw new TypeError(`Valor decimal inválido: "${value}"`);
  const frac = m[3] || '';
  let units = BigInt(`${m[2]}${frac}`) * (m[1] === '-' ? -1n : 1n);
  let scale = frac.length - Number(expText || 0); // notação científica (1e-7, 1.5e+21) expandida sem passar por float
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return { units, scale };
}

/**
 * Divisão inteira com arredondamento declarado (n / d, d > 0).
 * @param {bigint} n
 * @param {bigint} d
 * @param {string} mode HALF_UP | HALF_EVEN
 * @returns {bigint}
 */
function roundDiv(n, d, mode = DEFAULT_ROUNDING_MODE) {
  if (d <= 0n) throw new RangeError('Divisor precisa ser positivo.');
  if (!ROUNDING_MODES.includes(mode)) throw new RangeError(`Modo de arredondamento desconhecido: ${mode}`);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let q = abs / d;
  const r = abs % d;
  const twice = r * 2n;
  if (twice > d || (twice === d && (mode === 'HALF_UP' || q % 2n === 1n))) q += 1n;
  return negative ? -q : q;
}

/**
 * Valor monetário -> centavos inteiros. Mais de 2 casas é arredondado pelo modo informado (valores do banco já têm 2 casas).
 * @param {string|number|bigint} value
 * @param {string} [mode]
 * @returns {number}
 */
function toCents(value, mode = DEFAULT_ROUNDING_MODE) {
  const { units, scale } = parseDecimal(value);
  const cents = scale <= 2 ? units * 10n ** BigInt(2 - scale) : roundDiv(units, 10n ** BigInt(scale - 2), mode);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Valor fora da faixa de centavos.');
  return Number(cents);
}

/**
 * Centavos inteiros -> texto decimal com 2 casas ("1234.50"), o formato que o numeric do Postgres recebe sem perda.
 * @param {number|bigint} cents
 * @returns {string}
 */
function centsToDecimal(cents) {
  const big = BigInt(cents);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/**
 * Percentual de um valor em centavos, exato: base x (pct / 100), arredondado UMA vez pelo modo.
 * @param {number|bigint} baseCents
 * @param {string|number} percentage ex.: "5", "2.5", 33.333333
 * @param {string} [mode]
 * @returns {number} centavos
 */
function percentOfCents(baseCents, percentage, mode = DEFAULT_ROUNDING_MODE) {
  const { units, scale } = parseDecimal(percentage);
  const denominator = 100n * 10n ** BigInt(scale);
  return Number(roundDiv(BigInt(baseCents) * units, denominator, mode));
}

/**
 * Soma de valores monetários em centavos inteiros.
 * @param {Array<string|number>} values
 * @returns {number}
 */
function sumCents(values) {
  return values.reduce((/** @type {number} */ acc, v) => acc + toCents(v), 0);
}

module.exports = { ROUNDING_MODES, DEFAULT_ROUNDING_MODE, parseDecimal, roundDiv, toCents, centsToDecimal, percentOfCents, sumCents };
