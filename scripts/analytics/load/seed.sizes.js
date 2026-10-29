'use strict';

/**
 * M9-D699 (3.1) — tamanhos da massa de carga. "light" roda no teste automatizado; "full" é a massa do pipeline LAB (histórico de 24 meses).
 * Qualquer campo pode ser sobrescrito pelo chamador. O tamanho é fixture, não meta de desempenho.
 */
const SCALES = Object.freeze({
  light: { companies: 3, months: 24, entries: 6000, bankTransactions: 1200, opportunities: 2000, properties: 600, projects: 30, stages: 120, measurements: 1500, dailyReports: 1500 },
  full: { companies: 4, months: 24, entries: 150000, bankTransactions: 20000, opportunities: 40000, properties: 8000, projects: 300, stages: 1800, measurements: 40000, dailyReports: 40000 },
});

function sizesFor(options = {}) {
  const base = SCALES[options.scale || 'light'];
  if (!base) throw new Error(`Escala desconhecida: ${options.scale}. Use ${Object.keys(SCALES).join(' ou ')}.`);
  const defined = Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined && k !== 'scale' && k in base));
  return { seed: String(options.seed === undefined ? 42 : options.seed), ...base, ...defined };
}

/** A massa só entra em banco descartável em 127.0.0.1 (nunca na homologação compartilhada). */
function requireDisposable(adminUrl) {
  if (!process.env.DISPOSABLE_DB && !process.env.CI) throw new Error('recusado: a massa de carga só entra em banco descartável (scripts/withDisposableDb.js).');
  if (!adminUrl || !/@127\.0\.0\.1:/.test(adminUrl)) throw new Error('recusado: o destino precisa ser 127.0.0.1.');
}

module.exports = { SCALES, sizesFor, requireDisposable };
