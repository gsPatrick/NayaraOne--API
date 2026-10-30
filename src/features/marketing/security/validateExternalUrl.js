'use strict';

const { REASONS, inDomains, staticReasons } = require('./urlRules');
const { readUrlConfig } = require('./url.settings');

/**
 * M9-D433 — validateExternalUrl(url, ctx): os 8 critérios do Caderno §14 para qualquer URL que o Marketing aceita de fora (link rastreável, template, conteúdo, pesquisa).
 * Estáticos (https, allowlist, encurtador, credenciais, IP/localhost, tamanho) primeiro; sem nenhum motivo, o DNS do host é resolvido e cada endereço público é exigido
 * (6) e os redirecionamentos são seguidos até `maxSaltos`, cada salto passando de novo pelos mesmos critérios (7). Falha de rede = destino não verificável = recusa.
 * ctx: { tenant, transaction, origin? ('SYSTEM' = link montado pelo sistema), config? (para teste), resolver?, probe?, _tls?, _connect? }. Devolve { ok, reasons, url, hops }; quem lança o 422 é o chamador.
 * As portas de rede (`checkPublicHost`, `probeRedirect`) vêm do módulo de integrações, o único que fala HTTP.
 */
const ports = () => require('../../integrations').urlProbe;

async function followRedirects(startUrl, config, ctx) {
  const { checkPublicHost, probeRedirect } = ports();
  const probe = ctx.probe || probeRedirect;
  let current = startUrl;
  let hops = 0;
  for (;;) {
    const host = new URL(current).hostname.toLowerCase();
    const resolved = await checkPublicHost(host, { resolver: ctx.resolver });
    if (!resolved.ok) return { reasons: [resolved.reason === 'DNS_FAILED' ? REASONS.DNS_FAILED : REASONS.PRIVATE_DNS], hops };
    let answer;
    try {
      answer = await probe(current, { address: resolved.address, family: resolved.family, timeoutMs: config.timeoutMs, _tls: ctx._tls, _connect: ctx._connect });
    } catch (err) {
      return { reasons: [REASONS.UNVERIFIABLE], hops };
    }
    if (!answer || !answer.redirect) return { reasons: [], hops };
    if (hops >= config.maxHops) return { reasons: [REASONS.TOO_MANY_HOPS], hops };
    hops += 1;
    let next;
    try { next = new URL(answer.redirect, current); } catch (err) { return { reasons: [REASONS.INVALID], hops }; }
    const inside = staticReasons(next.href, config);
    if (inside.reasons.length > 0) return { reasons: [REASONS.REDIRECT_OUT, ...inside.reasons], hops };
    current = next.href;
  }
}

async function validateExternalUrl(rawUrl, ctx = {}) {
  const base = ctx.config || await readUrlConfig(ctx.tenant, ctx.transaction);
  // Link montado pelo próprio sistema (automação com a URL base da empresa): vale a regra estática; DNS e redirecionamento ficam para a URL que alguém digitou (DI-D433-3).
  const config = ctx.origin === 'SYSTEM' ? { ...base, verifyDestination: false } : base;
  const checked = staticReasons(rawUrl, config);
  if (checked.reasons.length > 0) return { ok: false, reasons: checked.reasons, url: null, hops: 0 };
  if (!config.verifyDestination) return { ok: true, reasons: [], url: checked.url.toString(), hops: 0 };
  const walked = await followRedirects(checked.url.href, config, ctx);
  if (walked.reasons.length > 0) return { ok: false, reasons: walked.reasons, url: null, hops: walked.hops };
  return { ok: true, reasons: [], url: checked.url.toString(), hops: walked.hops };
}

module.exports = { validateExternalUrl, followRedirects, inDomains };
