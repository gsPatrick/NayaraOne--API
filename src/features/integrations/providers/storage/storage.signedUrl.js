'use strict';

const crypto = require('node:crypto');

/** TTL final da URL assinada: o pedido limitado pelo máximo da configuração (M9-D242 3.1). Pedido inválido ou ausente vale o máximo. */
function clampTtl(requested, maxTtlSeconds) {
  const max = Number(maxTtlSeconds);
  const pedido = Number(requested);
  if (!Number.isFinite(pedido) || pedido <= 0) return max;
  return Math.min(Math.floor(pedido), max);
}

const hmac = (secret, texto) => crypto.createHmac('sha256', secret).update(texto).digest('hex');

/** URL assinada do sandbox: `https://<host>/<chave>?method=..&exp=..&sig=..` (HMAC com o segredo do processo). */
function signSandboxUrl(secret, host, key, method, exp) {
  const m = String(method || 'GET').toUpperCase();
  return `https://${host}/${key}?method=${m}&exp=${exp}&sig=${hmac(secret, `${m}|${key}|${exp}`)}`;
}

/** Confere a URL do sandbox no instante `now` (ms): { ok, reason }. */
function verifySandboxUrl(secret, url, now = Date.now()) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'MALFORMED' }; }
  const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const method = u.searchParams.get('method');
  const exp = Number(u.searchParams.get('exp'));
  const esperado = hmac(secret, `${method}|${key}|${exp}`);
  const sig = u.searchParams.get('sig') || '';
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return { ok: false, reason: 'SIGNATURE' };
  if (!Number.isFinite(exp) || now >= exp * 1000) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, key, method };
}

module.exports = { clampTtl, signSandboxUrl, verifySandboxUrl };
