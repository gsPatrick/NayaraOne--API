'use strict';

/**
 * M9-D699 (3.2) — estatística das amostras de latência: p50, p95 e p99 pelo método do posto mais próximo (sem interpolação, como as demais
 * cargas do projeto) e agrupamento por rótulo. Amostras em milissegundos com fração.
 */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round3 = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

/** { count, errors, p50, p95, p99, max } de uma lista de { ms, ok }. */
function summarize(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  return {
    count: samples.length, errors: samples.filter((s) => !s.ok).length,
    p50: round3(percentile(ok, 50)), p95: round3(percentile(ok, 95)), p99: round3(percentile(ok, 99)), max: round3(ok.length ? ok[ok.length - 1] : null),
  };
}

/** Acumulador por rótulo: record(label, ms, ok, detail) e summary() => { rótulo: resumo }. */
function createRecorder() {
  const byLabel = new Map();
  return {
    record(label, ms, ok = true, detail = null) {
      if (!byLabel.has(label)) byLabel.set(label, { samples: [], details: {} });
      const entry = byLabel.get(label);
      entry.samples.push({ ms, ok });
      if (!ok && detail) entry.details[detail] = (entry.details[detail] || 0) + 1;
    },
    samples: (label) => (byLabel.has(label) ? byLabel.get(label).samples : []),
    labels: () => [...byLabel.keys()],
    summary() {
      return Object.fromEntries([...byLabel].map(([label, e]) => [label, { ...summarize(e.samples), failures: e.details }]));
    },
    raw: () => Object.fromEntries([...byLabel].map(([label, e]) => [label, e.samples])),
  };
}

/** Junta duas listas de amostras por rótulo (rodadas alternadas A/B/A/B). */
function mergeRaw(parts) {
  const out = {};
  for (const part of parts) for (const [label, list] of Object.entries(part)) out[label] = (out[label] || []).concat(list);
  return out;
}

const summarizeRaw = (raw) => Object.fromEntries(Object.entries(raw).map(([label, list]) => [label, summarize(list)]));

module.exports = { percentile, summarize, createRecorder, mergeRaw, summarizeRaw };
