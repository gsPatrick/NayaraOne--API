'use strict';

const RATIO_RE = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;

/** "9:16" -> 0.5625; "1.91:1" -> 1.91; texto fora do formato ou com zero -> null. */
function ratioValue(text) {
  const m = RATIO_RE.exec(String(text || '').trim());
  if (!m) return null;
  const w = Number(m[1]); const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Largura e altura inteiras viram a proporção reduzida ("W:H"): 1080x1350 -> "4:5". */
function ratioOfSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

/** A proporção está entre as aceitas, dentro da tolerância (em %, parâmetro)? */
function ratioMatches(actual, allowed, tolerancePct) {
  const a = ratioValue(actual);
  if (a === null) return false;
  return allowed.some((candidate) => {
    const b = ratioValue(candidate);
    return b !== null && Math.abs(a - b) / b <= tolerancePct / 100;
  });
}

module.exports = { ratioValue, ratioOfSize, ratioMatches, RATIO_RE };
