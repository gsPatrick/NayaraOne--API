'use strict';

/**
 * M9-D694 (3.3 a) — conferência numérica do briefing. Todo número citado no texto precisa casar, até a 2ª casa, com um valor da entrada
 * (métricas, variações, alertas, registros de causa). O sinal não conta ("caiu R$ 18.000,00" casa com -18000). Datas, horas e
 * identificadores (P-221) não são números do negócio. Contagens de itens (1 até o total) são permitidas: "hoje há 2 exceções".
 * Aritmética decimal exata do BI (sem ponto flutuante).
 */
const money = require('../metrics/formulas/money');

const IGNORED_KEYS = new Set(['refId', 'id', 'alertCode', 'metricCode', 'dimension', 'dimensionValue', 'fonte', 'tipoSugerido']);
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})/;
const STRIP = [/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, /\b\d{1,2}:\d{2}(?::\d{2})?\b/g, /\b\d{4}-\d{2}\b/g];
const TOKEN = /(?<![\w.,/:-])-?\d+(?:[.,]\d+)*(?!\d)/g;

/** "13.500,00" -> "13500.00"; "13500.00" -> "13500.00"; "13.500" (milhar) -> "13500"; "112000" -> "112000". */
function normalizeToken(raw) {
  const t = raw.replace(/^-/, '');
  if (t.includes(',')) return t.replace(/\./g, '').replace(',', '.');
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return t.replace(/\./g, '');
  return t;
}

function fixed2(text) {
  try { return money.toString(money.round(money.dec(text), 2)).replace(/^-/, ''); } catch (err) { return null; }
}

/** Números do texto (já em 2 casas, sem sinal), fora datas, horas e identificadores. */
function numbersIn(text) {
  let clean = String(text ?? '');
  for (const re of STRIP) clean = clean.replace(re, ' ');
  const out = [];
  for (const m of clean.matchAll(TOKEN)) {
    const value = fixed2(normalizeToken(m[0]));
    out.push({ raw: m[0], value });
  }
  return out;
}

function collect(node, set) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, set)); return; }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) if (!IGNORED_KEYS.has(key)) collect(value, set);
    return;
  }
  if (typeof node === 'number' && Number.isFinite(node)) { const v = fixed2(String(node)); if (v) set.add(v); return; }
  if (typeof node !== 'string') return;
  if (PLAIN_NUMBER.test(node)) { const v = fixed2(node); if (v) set.add(v); return; }
  const date = DATE_PART.exec(node);
  if (date) for (const part of date.slice(1)) set.add(fixed2(String(Number(part))));
}

/** Conjunto de números citáveis da entrada: valores, variações, contagens e as partes das datas dos períodos. */
function allowedNumbers(entrada) {
  const set = new Set();
  collect(entrada, set);
  const total = Array.isArray(entrada.itens) ? entrada.itens.length : 0;
  for (let n = 0; n <= total; n += 1) set.add(fixed2(String(n)));
  return set;
}

/** Primeiro número do texto que não casa com a entrada, ou null. */
function firstMismatch(text, allowed) {
  const hit = numbersIn(text).find((n) => n.value === null || !allowed.has(n.value));
  return hit ? hit.raw : null;
}

module.exports = { numbersIn, allowedNumbers, firstMismatch, normalizeToken };
