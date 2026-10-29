'use strict';

const { NUM, parseBR } = require('./text');
const { mismatchOrMissing } = require('./finding');

/** Campos do read model que são preço (em reais); o texto só pode citar um destes valores, em centavos, com tolerância 0. */
const PRICE_FIELDS = Object.freeze(['precoVenda', 'precoLocacao', 'precoAnterior', 'condominio', 'iptu']);
const SUFFIX = '(milhoes|milhao|mil|mi|k)';
const MULTIPLIER = Object.freeze({ milhoes: 1e6, milhao: 1e6, mi: 1e6, mil: 1e3, k: 1e3 });

const PATTERNS = Object.freeze([
  new RegExp(`r\\$\\s*${NUM}(?:\\s*${SUFFIX}\\b)?`, 'g'),
  new RegExp(`(?<![\\d.,])${NUM}\\s*${SUFFIX}\\b`, 'g'),
  new RegExp(`(?<![\\d.,])${NUM}\\s*reais\\b`, 'g'),
]);

function centsOf(numberText, suffix) {
  return Math.round(parseBR(numberText) * (suffix ? MULTIPLIER[suffix] : 1) * 100);
}

/** Preço: `R$ 780.000`, `780 mil`, `R$780k`, `0,78 milhão`, `780.000 reais`, normalizados em centavos. */
function checkPrice(doc, facts) {
  const allowed = PRICE_FIELDS.map((f) => facts[f]).filter((v) => v !== null && v !== undefined && v !== '').map((v) => Math.round(Number(v) * 100));
  const findings = [];
  for (const pattern of PATTERNS) {
    for (const { m, start, end } of doc.matches(pattern)) {
      const cents = centsOf(m[1], m[2]);
      doc.mask(start, end);
      if (Number.isFinite(cents) && allowed.includes(cents)) continue;
      findings.push(mismatchOrMissing({
        kind: 'PRICE', claim: doc.slice(start, end), expected: allowed.map((c) => c / 100), found: cents / 100, hasData: allowed.length > 0, label: 'o preço',
      }));
    }
  }
  return findings;
}

module.exports = { checkPrice, PRICE_FIELDS };
