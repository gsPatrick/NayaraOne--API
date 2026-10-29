'use strict';

/**
 * M9-D703 (3.1) — texto do último valor do alerta (`formattedLastValue`), por unidade da métrica, no padrão brasileiro (milhar com ponto, decimal com
 * vírgula). Aritmética em texto/BigInt: nenhum ponto flutuante passa pelo dinheiro. Dinheiro e porcentagem têm 2 casas; as demais unidades mostram até 4 casas
 * sem zeros à direita (sem inventar precisão).
 */
const TEXT_RE = /^(-?)(\d+)(?:\.(\d+))?$/;
const SPEC = Object.freeze({
  BRL: { digits: 2, fixed: true, prefix: 'R$ ' },
  PERCENT: { digits: 2, fixed: true, suffix: '%' },
  PP: { digits: 2, fixed: true, suffix: ' p.p.' },
  BRL_PER_UNIT: { digits: 2, fixed: true, prefix: 'R$ ', suffix: '/un' },
  DAYS: { digits: 4, suffix: ' dias' },
  HOURS: { digits: 4, suffix: ' h' },
  MINUTES: { digits: 4, suffix: ' min' },
  SECONDS: { digits: 4, suffix: ' s' },
  COUNT: { digits: 4 },
  SCORE: { digits: 4 },
  NUMBER: { digits: 4 },
});

/** "42000.5000" -> "42000.5"; "1000.0000" -> "1000"; texto não numérico volta como está. */
function normalizeDecimal(value) {
  if (value === null || value === undefined) return null;
  const m = TEXT_RE.exec(String(value).trim());
  if (!m) return String(value);
  const frac = (m[3] || '').replace(/0+$/, '');
  const int = m[2].replace(/^0+(?=\d)/, '');
  const negative = m[1] === '-' && (int !== '0' || frac !== '');
  return `${negative ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Arredonda (meio para longe do zero) para `digits` casas, em BigInt. Devolve { negative, int, frac } em texto. */
function round(m, digits) {
  const frac = (m[3] || '').padEnd(digits + 1, '0');
  const scaled = BigInt(m[2] + frac.slice(0, digits)) + (Number(frac[digits]) >= 5 ? 1n : 0n);
  const text = scaled.toString().padStart(digits + 1, '0');
  return { negative: m[1] === '-', int: text.slice(0, text.length - digits), frac: text.slice(text.length - digits) };
}

const group = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function formatValue(value, unit) {
  if (value === null || value === undefined) return null;
  const m = TEXT_RE.exec(String(value).trim());
  if (!m) return String(value);
  const spec = SPEC[unit] || SPEC.NUMBER;
  const { negative, int, frac } = round(m, spec.digits);
  const shownFrac = spec.fixed ? frac : frac.replace(/0+$/, '');
  const zero = /^0*$/.test(int) && /^0*$/.test(frac);
  const body = `${group(int)}${shownFrac ? `,${shownFrac}` : ''}`;
  return `${spec.prefix || ''}${negative && !zero ? '-' : ''}${body}${spec.suffix || ''}`;
}

module.exports = { formatValue, normalizeDecimal };
