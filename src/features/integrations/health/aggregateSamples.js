'use strict';

const { percentile } = require('./percentile');

const inteiro = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);

/**
 * Transforma a amostra de uma janela nas métricas gravadas em provider_health (M9-D206, regra 3.1).
 * `sample`: { calls: [{ ok, latencyMs }], rateLimitCount, authFailures, retriesTotal, dlqCount, backlogCount }.
 * Sem chamadas não existe taxa de sucesso (null): não se inventa 100% nem 0%.
 */
function aggregateSamples(sample = {}) {
  const calls = Array.isArray(sample.calls) ? sample.calls : [];
  const callsTotal = calls.length;
  const callsSuccess = calls.filter((c) => c && c.ok === true).length;
  const latencias = calls.map((c) => Number(c && c.latencyMs)).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return {
    callsTotal,
    callsSuccess,
    callsFailed: callsTotal - callsSuccess,
    successRate: callsTotal === 0 ? null : Math.round((callsSuccess / callsTotal) * 10000) / 100,
    latencyP50Ms: percentile(latencias, 50),
    latencyP95Ms: percentile(latencias, 95),
    latencyP99Ms: percentile(latencias, 99),
    rateLimitCount: inteiro(sample.rateLimitCount),
    authFailures: inteiro(sample.authFailures),
    retriesTotal: inteiro(sample.retriesTotal),
    dlqCount: inteiro(sample.dlqCount),
    backlogCount: inteiro(sample.backlogCount),
  };
}

module.exports = { aggregateSamples };
