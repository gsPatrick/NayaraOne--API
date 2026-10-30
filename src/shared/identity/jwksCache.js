'use strict';

const crypto = require('node:crypto');

/**
 * Cache de JWKS (Marco 9, M9-D242 3.2): `fetchJwks()` devolve { keys: [JWK] } do provedor; o cache guarda por `ttlMs`, escolhe a chave pelo `kid` e
 * a converte em chave pública. Chave desconhecida força UMA releitura (rotação de chaves) e, se ainda não achar, devolve null.
 * `now` é injetável (testes).
 */
function createJwksCache({ fetchJwks, ttlMs, now = () => Date.now() }) {
  let keys = null;
  let loadedAt = 0;
  let loads = 0;

  async function load() {
    const doc = await fetchJwks();
    keys = new Map((Array.isArray(doc && doc.keys) ? doc.keys : []).filter((k) => k && k.kid).map((k) => [k.kid, k]));
    loadedAt = now();
    loads += 1;
  }

  /** Chave pública (KeyObject) do `kid`, ou null. */
  async function getKey(kid) {
    if (!keys || now() - loadedAt >= ttlMs) await load();
    if (!keys.has(kid)) await load();
    const jwk = keys.get(kid);
    return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
  }

  return { getKey, invalidate() { keys = null; }, stats: () => ({ loads, cached: keys ? keys.size : 0 }) };
}

module.exports = { createJwksCache };
