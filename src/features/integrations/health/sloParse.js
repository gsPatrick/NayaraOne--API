'use strict';

/**
 * Meta de SLO por criticidade, escrita no parâmetro `integration.slo.<CRITICIDADE>` (M9-D225 é a dona da edição):
 * "99.5% / p95 5 s / p99 12 s / backlog 15 min". Esta leitura só extrai os números.
 */
const SLO_RE = /^\s*(\d+(?:[.,]\d+)?)\s*%\s*\/\s*p95\s+(\d+(?:[.,]\d+)?)\s*s\s*\/\s*p99\s+(\d+(?:[.,]\d+)?)\s*s\s*\/\s*backlog\s+(\d+(?:[.,]\d+)?)\s*(min|h)\s*$/i;

const numero = (txt) => Number(String(txt).replace(',', '.'));

function parseSlo(texto) {
  const m = typeof texto === 'string' ? SLO_RE.exec(texto) : null;
  if (!m) return null;
  return {
    minSuccessRate: numero(m[1]),
    p95Ms: Math.round(numero(m[2]) * 1000),
    p99Ms: Math.round(numero(m[3]) * 1000),
    backlogMin: Math.round(numero(m[4]) * (m[5].toLowerCase() === 'h' ? 60 : 1)),
  };
}

/** Texto padrão de cada criticidade (parametros.csv, INT-P044 a INT-P047). */
const DEFAULT_SLO_TEXT = Object.freeze({
  CRITICAL: '99.9% / p95 3 s / p99 8 s / backlog 5 min',
  HIGH: '99.5% / p95 5 s / p99 12 s / backlog 15 min',
  MEDIUM: '99.0% / p95 8 s / p99 20 s / backlog 60 min',
  LOW: '95.0% / p95 15 s / p99 40 s / backlog 24 h',
});

const DEFAULT_SLO = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_SLO_TEXT).map(([k, v]) => [k, Object.freeze(parseSlo(v))])));

module.exports = { parseSlo, DEFAULT_SLO, DEFAULT_SLO_TEXT };
