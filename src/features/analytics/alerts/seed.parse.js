'use strict';

/**
 * M9-D691 (3.3) — interpreta o texto do parâmetro de um alerta semente. Devolve { metricCode, dimensionKey, operator, value, severity,
 * createTask } (ou { kind: 'FRESHNESS', severity, createTask } para o alerta de freshness) ou null se o texto não segue o formato.
 */
const OPERATORS = { '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE', '=': 'EQ', '!=': 'NEQ' };
const THRESHOLD_RE = /^\s*([a-z][a-z0-9]*\.[a-z][a-z0-9_]*)\s+(?:([^<>=!,\s][^<>=!,]*?)\s+)?(<=|>=|!=|<|>|=)\s*(?:R\$\s*)?(-?[\d.,]+)\s*%?\s*,\s*(INFO|WARNING|CRITICAL)(\s+com tarefa)?\s*$/;
const FRESHNESS_RE = /^\s*métrica CRITICAL em STALE\s*,\s*(INFO|WARNING|CRITICAL)(\s+com tarefa)?\s*$/;

/** "50.000,00" -> 50000; "75.000,50" -> 75000.5; "10" -> 10; "0,5" -> 0.5; "1.500" (milhar sem decimais) -> 1500. */
function parseAmount(text) {
  let t = text;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseSeedText(text) {
  const raw = String(text ?? '');
  const f = FRESHNESS_RE.exec(raw);
  if (f) return { kind: 'FRESHNESS', severity: f[1], createTask: Boolean(f[2]) };
  const m = THRESHOLD_RE.exec(raw);
  if (!m) return null;
  const value = parseAmount(m[4]);
  if (value === null) return null;
  return { kind: 'THRESHOLD', metricCode: m[1], dimensionKey: m[2] ? m[2].trim() : '', operator: OPERATORS[m[3]], value, severity: m[5], createTask: Boolean(m[6]) };
}

module.exports = { parseSeedText, parseAmount };
