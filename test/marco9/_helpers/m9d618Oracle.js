'use strict';

// Cálculo INDEPENDENTE (JavaScript puro, BigInt) dos números esperados da M9-D618, para conferir o SQL do read model sem copiá-lo.
const DAY = 86400000;

/** num ÷ den arredondado meio para cima em 6 casas, como texto ('37.999962'). */
function ratio6(num, den) {
  const n = BigInt(num) * 10n ** 7n;
  const q = n / BigInt(den);
  const r = (q + 5n) / 10n;
  const s = r.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Término previsto pelo ritmo: início + teto(decorridos × 100 ÷ %), em inteiros (% em milionésimos). */
function paceFinish(startDate, asOf, percent6) {
  const pct = BigInt(percent6.replace('.', ''));
  const elapsed = BigInt(daysBetween(startDate, asOf));
  const days = Number((elapsed * 100n * 1000000n + pct - 1n) / pct);
  return addDays(startDate, days);
}

const byKey = (rows, fields) => new Map(rows.map((r) => [fields.map((f) => r[f]).join('|'), r]));
const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f]]));

module.exports = { ratio6, addDays, daysBetween, paceFinish, byKey, pick };
