'use strict';

const { semAcento } = require('../../orchestrator/numbers/decimalText');

const norm = (texto) => semAcento(texto).replace(/\s+/g, ' ').trim();

/** "a, b ,c" ou lista -> termos normalizados (sem acento, minúsculos), sem vazios. */
function termsOf(raw, fallback) {
  const base = raw === undefined || raw === null ? fallback : raw;
  const lista = Array.isArray(base) ? base : String(base || '').split(',');
  return lista.map((t) => norm(t)).filter(Boolean);
}

const contains = (texto, termos) => termos.find((t) => texto.includes(t)) || null;

/**
 * Decide o destino do pedido: FORBIDDEN (uma das proibições do livro, primeira da lista que casa), OUT_OF_SCOPE (nenhum termo do
 * propósito) ou IN_SCOPE. As proibições valem antes do escopo: pedir para aprovar o que o agente não aprova é recusa de fronteira.
 * `prohibitions`: [{ code, terms }]; `scopeTerms`: lista já normalizada.
 */
function evaluateScope(input, { scopeTerms, prohibitions }) {
  const texto = norm(input);
  for (const p of prohibitions) {
    const hit = contains(texto, p.terms);
    if (hit) return { decision: 'FORBIDDEN', code: p.code, matched: hit };
  }
  if (!contains(texto, scopeTerms)) return { decision: 'OUT_OF_SCOPE', code: null, matched: null };
  return { decision: 'IN_SCOPE', code: null, matched: null };
}

module.exports = { evaluateScope, termsOf, norm };
