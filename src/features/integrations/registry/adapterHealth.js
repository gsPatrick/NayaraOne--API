'use strict';

const { readAdapterParams } = require('./adapters.params');

const falha = (detail, started) => ({ ok: false, latencyMs: Math.max(0, Date.now() - started), detail: String(detail).slice(0, 300) });

/**
 * runHealthCheck — chama adapter.healthCheck(ctx) com o tempo máximo `integration.health.check_timeout_ms` e NUNCA lança:
 * exceção, tempo esgotado ou resposta fora do formato { ok, latencyMs, detail, quota? } viram { ok:false, ... }.
 */
async function runHealthCheck(adapter, tenant, transaction) {
  const started = Date.now();
  let timer;
  try {
    const { healthCheckTimeoutMs } = adapter.ctx?.healthCheckTimeoutMs ? { healthCheckTimeoutMs: adapter.ctx.healthCheckTimeoutMs } : await readAdapterParams(tenant, transaction);
    const resposta = await Promise.race([
      Promise.resolve().then(() => adapter.healthCheck(adapter.ctx)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`tempo esgotado (${healthCheckTimeoutMs} ms)`)), healthCheckTimeoutMs); }),
    ]);
    if (!resposta || typeof resposta.ok !== 'boolean' || !Number.isFinite(resposta.latencyMs) || typeof resposta.detail !== 'string') return falha('resposta do teste de saúde fora do formato', started);
    const out = { ok: resposta.ok, latencyMs: resposta.latencyMs, detail: resposta.detail.slice(0, 300) };
    if (resposta.quota) out.quota = resposta.quota;
    return out;
  } catch (err) {
    return falha(adapter.redact ? String(adapter.redact({ m: err && err.message }).m ?? 'falha') : 'falha', started);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runHealthCheck };
