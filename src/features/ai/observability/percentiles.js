'use strict';

/** p50, p95 e p99 da latência das execuções (M9-D047), estimados pelos limites do histograma ai_run_latency_ms (interpolação linear dentro do limite). */
const { latency } = require('./metrics');

function quantile(buckets, total, q) {
  const alvo = total * q;
  let anterior = { le: 0, count: 0 };
  for (const b of buckets) {
    if (b.count >= alvo) {
      if (b.le === Infinity || b.count === anterior.count) return anterior.le;
      return anterior.le + ((b.le - anterior.le) * (alvo - anterior.count)) / (b.count - anterior.count);
    }
    anterior = b;
  }
  return anterior.le;
}

/** Soma os agentes (ou só `agent`) e devolve { count, p50, p95, p99 } em ms; sem execuções, tudo zero. */
async function latencyPercentiles({ agent } = {}) {
  const { values } = await latency.get();
  const porLimite = new Map();
  for (const v of values.filter((x) => x.metricName === 'ai_run_latency_ms_bucket' && (!agent || x.labels.agent === agent))) {
    const le = v.labels.le === '+Inf' ? Infinity : Number(v.labels.le);
    porLimite.set(le, (porLimite.get(le) || 0) + v.value);
  }
  const buckets = [...porLimite.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
  const count = buckets.length ? buckets[buckets.length - 1].count : 0;
  if (!count) return { count: 0, p50: 0, p95: 0, p99: 0 };
  const r = (q) => Math.round(quantile(buckets, count, q) * 100) / 100;
  return { count, p50: r(0.5), p95: r(0.95), p99: r(0.99) };
}

module.exports = { latencyPercentiles, quantile };
