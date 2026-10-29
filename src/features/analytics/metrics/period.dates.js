'use strict';

/** M9-D606 — aritmética de datas de calendário (AAAA-MM-DD) em UTC puro, sem fuso do servidor. Usada só pelo resolvedor de período. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1000;

const pad = (n, size = 2) => String(n).padStart(size, '0');
const key = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** { y, m, d } de uma data de calendário válida, ou null (30/02, formato errado, ano fora de 1000..9999). */
function parseDate(text) {
  const match = DATE_RE.exec(String(text));
  if (!match) return null;
  const y = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const d = Number.parseInt(match[3], 10);
  if (y < MIN_YEAR || m < 1 || m > 12 || d < 1 || d > lastDayOfMonth(y, m)) return null;
  return { y, m, d };
}

/** Soma `days` dias (negativo volta) a uma data AAAA-MM-DD. */
function addDays(text, days) {
  const { y, m, d } = parseDate(text);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Soma meses ao PRIMEIRO dia do mês de `text` (resultado sempre dia 01). */
function addMonthsFirstDay(text, months) {
  const { y, m } = parseDate(text);
  const index = y * 12 + (m - 1) + months;
  return key(Math.floor(index / 12), (index % 12) + 1, 1);
}

const monthKey = (text) => text.slice(0, 7);

module.exports = { pad, key, lastDayOfMonth, parseDate, addDays, addMonthsFirstDay, monthKey };
