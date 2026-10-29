'use strict';

const FUSO = 'America/Sao_Paulo';
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

/** Data/hora em São Paulo como { y, m, d }. */
function partsOf(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** "18/10/2026" no fuso de São Paulo. */
function dateBR(date) {
  if (!date) return null;
  const p = partsOf(date);
  return `${pad(p.d)}/${pad(p.m)}/${p.y}`;
}

/** Dias corridos (calendário de São Paulo) de `from` até `to`; nunca negativo. Calculado pelo código, nunca pelo modelo. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = partsOf(from);
  const b = partsOf(to);
  return Math.max(0, Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS));
}

/** "R$ 1.234,50" a partir de um decimal em texto ou número. */
function brl(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const plural = (n, um, varios) => (n === 1 ? um : varios);

module.exports = { dateBR, daysBetween, brl, plural, FUSO, DAY_MS };
