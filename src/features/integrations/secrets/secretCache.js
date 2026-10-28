'use strict';

/** Cache em memória do segredo lido (M9-D202 regra 2): no máximo `integration.secret.cache_ttl_s`. Guarda SecretValue, nunca texto. */
const cache = new Map();

const keyOf = (companyId, connectionId, ref, version) => `${companyId}|${connectionId}|${ref}|${version ?? 'current'}`;

function getCached(key, nowMs) {
  const e = cache.get(key);
  if (!e) return null;
  if (nowMs >= e.expiresAtMs) { cache.delete(key); return null; }
  return e.entrega;
}

function setCached(key, entrega, ttlS, nowMs) {
  if (ttlS > 0) cache.set(key, { entrega, expiresAtMs: nowMs + ttlS * 1000 });
}

function clearConnectionCache(companyId, connectionId) {
  const prefixo = `${companyId}|${connectionId}|`;
  [...cache.keys()].filter((k) => k.startsWith(prefixo)).forEach((k) => cache.delete(k));
}

const clearSecretCache = () => cache.clear();

module.exports = { keyOf, getCached, setCached, clearConnectionCache, clearSecretCache };
