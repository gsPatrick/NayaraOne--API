'use strict';

const crypto = require('node:crypto');

/** JSON canônico: chaves em ordem, sem undefined; a mesma linha gera sempre o mesmo texto. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const rowHash = (row) => sha256(canonicalJson(row));

/**
 * Traduz a linha crua da origem para os campos canônicos do Nayara pelo `columnMap` da fonte ({colunaLegada: campo}). Sem mapa, a linha já é canônica. Coluna fora do mapa não
 * entra; o mapa é dado da fonte (semente), nunca código.
 */
function mapRow(raw, columnMap) {
  if (!columnMap || !Object.keys(columnMap).length) return { ...raw };
  const out = {};
  for (const [column, field] of Object.entries(columnMap)) if (raw[column] !== undefined) out[field] = raw[column];
  return out;
}

module.exports = { canonicalJson, sha256, rowHash, mapRow };
