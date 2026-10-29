'use strict';

const { headerOf, parseRetryAfterMs } = require('../retry/retry.delay');

const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/** X-RateLimit-Reset: instante em segundos desde 1970, segundos até a renovação ou data ISO/HTTP. */
function resetInstant(valor, now) {
  if (valor === null || valor === undefined || valor === '') return null;
  const texto = String(valor).trim();
  if (/^\d+(\.\d+)?$/.test(texto)) {
    const n = Number(texto);
    return new Date(n > 1e9 ? n * 1000 : now.getTime() + n * 1000);
  }
  const quando = Date.parse(texto);
  return Number.isNaN(quando) ? null : new Date(quando);
}

/**
 * extractQuotaFromHeaders — lê a cota que o fornecedor informa nos cabeçalhos (M9-D218 3.1 item 2): X-RateLimit-Limit, -Remaining e
 * -Reset (também sem o "X-" e com "RateLimit-"), e Retry-After como renovação quando não há Reset. Devolve { limit, remaining,
 * resetsAt } ou null quando nada utilizável veio. `source` tem `headers` (objeto com get() ou propriedades).
 */
function extractQuotaFromHeaders(source, now = new Date()) {
  const pega = (nome) => headerOf(source, `x-ratelimit-${nome}`) ?? headerOf(source, `ratelimit-${nome}`);
  const limit = numero(pega('limit'));
  const remaining = numero(pega('remaining'));
  let resetsAt = resetInstant(pega('reset'), now);
  if (!resetsAt) {
    const espera = parseRetryAfterMs(headerOf(source, 'retry-after'), now);
    if (espera !== null) resetsAt = new Date(now.getTime() + espera);
  }
  if (limit === null && remaining === null && !resetsAt) return null;
  return { limit, remaining, resetsAt };
}

/** Cota de uma resposta ou erro: a do adapter (`extractQuota`) com defesa contra adapter que lança. */
function extractQuotaSafely(adapter, responseOrError, now) {
  try {
    const q = adapter && typeof adapter.extractQuota === 'function' ? adapter.extractQuota(responseOrError, now) : extractQuotaFromHeaders(responseOrError, now);
    if (!q) return null;
    const limit = numero(q.limit);
    const remaining = numero(q.remaining);
    const resetsAt = q.resetsAt ? new Date(q.resetsAt) : null;
    return limit === null && remaining === null && !resetsAt ? null : { limit, remaining, resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null };
  } catch {
    return null;
  }
}

module.exports = { extractQuotaFromHeaders, extractQuotaSafely, resetInstant };
