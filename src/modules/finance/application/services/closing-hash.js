'use strict';

// Valores em centavos e hash canônico usados pelo fechamento (retratos das conferências e
// snapshot do mês fechado).

const crypto = require('crypto');

function centsOf(value) {
  return Math.round(Number(value || 0) * 100);
}

function moneyOf(cents) {
  return (cents / 100).toFixed(2);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// JSON canônico (chaves ordenadas) — o mesmo conteúdo sempre gera o mesmo hash.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

module.exports = { centsOf, moneyOf, sha256, canonicalJson };
