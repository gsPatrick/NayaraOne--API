'use strict';

/**
 * Fontes das amostras de chamadas (M9-D206). A tabela provider_health agrega o que as chamadas aos fornecedores
 * produziram; quem sabe disso são os dispatches (M9-D205/D214), o circuit breaker (M9-D217) e o monitor de quota
 * (M9-D218). Cada um registra aqui a sua fonte, sem que esta área dependa de tabelas que ainda não existem.
 *
 * Uma fonte é `async ({ connection, from, to, windowMinutes }, transaction) => sample`, onde sample é
 * { calls: [{ ok, latencyMs }], rateLimitCount, authFailures, retriesTotal, dlqCount, backlogCount,
 *   quota: { limit, remaining, resetsAt } | null, lastSampleAt }. Sem fonte registrada, a amostra vem vazia.
 */
const sources = [];

function registerHealthSampleSource(fn) {
  if (typeof fn !== 'function') throw new TypeError('A fonte de amostras deve ser uma função.');
  sources.push(fn);
}

function resetHealthSampleSources() {
  sources.length = 0;
}

const soma = (a, b) => Number(a || 0) + Number(b || 0);
const maisRecente = (a, b) => (a && b ? (new Date(a) > new Date(b) ? a : b) : a || b || null);

async function collectSample(args, transaction) {
  const out = { calls: [], rateLimitCount: 0, authFailures: 0, retriesTotal: 0, dlqCount: 0, backlogCount: 0, quota: null, lastSampleAt: null };
  for (const fn of sources) {
    const s = (await fn(args, transaction)) || {};
    if (Array.isArray(s.calls)) out.calls.push(...s.calls);
    out.rateLimitCount = soma(out.rateLimitCount, s.rateLimitCount);
    out.authFailures = soma(out.authFailures, s.authFailures);
    out.retriesTotal = soma(out.retriesTotal, s.retriesTotal);
    out.dlqCount = soma(out.dlqCount, s.dlqCount);
    out.backlogCount = soma(out.backlogCount, s.backlogCount);
    out.quota = out.quota || s.quota || null;
    out.lastSampleAt = maisRecente(out.lastSampleAt, s.lastSampleAt);
  }
  return out;
}

module.exports = { registerHealthSampleSource, resetHealthSampleSources, collectSample };
