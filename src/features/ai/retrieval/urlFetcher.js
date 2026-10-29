'use strict';

const { fetchExternalUrl } = require('../../integrations/http/ssrfGuard');
const { matchHost } = require('../../integrations/http/egressPolicy');

/**
 * Busca de URL externa para a ingestão (M9-D022, passo 8). A NAY nunca busca URL sozinha: este código só roda dentro de uma ingestão pedida
 * por uma pessoa (ai:admin). Valem DUAS listas, e a mais restritiva vence: (1) `ia.rag.dominios_permitidos`, a lista funcional (quais
 * domínios podem virar conhecimento), conferida aqui; (2) `integration.ssrf.fetch_allowlist` no fluxo `nay_document`, a lista de rede
 * (para onde o servidor pode conectar), conferida pelo guarda. TODA regra de rede (esquema, DNS, IP privado, redirecionamento, tamanho,
 * tempo) é do `ssrfGuard.fetchExternalUrl` da M9-D245: não há cliente HTTP nem regra SSRF própria aqui.
 * Erro: { code: 'URL_BLOCKED' } (lista funcional ou bloqueio do guarda) ou { code: 'FETCH_FAILED' } (rede, tempo ou resposta ruim).
 */
const FLOW = 'nay_document';
/** Recusas do guarda (endereço, tamanho, tipo de conteúdo): a URL não serve. Rede e tempo viram falha técnica (reenviar é seguro). */
const REFUSED = ['INTEGRATION_SSRF_BLOCKED', 'INTEGRATION_FETCH_TOO_LARGE', 'INTEGRATION_FETCH_UNSUPPORTED_MEDIA'];
const fail = (code) => Object.assign(new Error(code), { code });

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch (err) {
    return null;
  }
}

/** O host está na lista funcional da empresa? Lista vazia = nenhuma URL. */
const domainAllowed = (host, domains) => Boolean(host) && domains.some((d) => matchHost(d, host));

/** fetchForIngestion(url, { tenant, allowedDomains }, transaction, hooks) => { buffer, contentType, sha256, host }. `hooks`: só de teste (DNS e conexão). */
async function fetchForIngestion(url, { tenant, allowedDomains }, transaction, hooks = {}) {
  if (!domainAllowed(hostOf(url), allowedDomains)) throw fail('URL_BLOCKED');
  try {
    const r = await fetchExternalUrl(url, { flow: FLOW, tenant, transaction, ...hooks });
    return { buffer: r.buffer, contentType: r.contentType, sha256: r.sha256, host: r.host };
  } catch (err) {
    throw fail(err && REFUSED.includes(err.code) ? 'URL_BLOCKED' : 'FETCH_FAILED');
  }
}

module.exports = { fetchForIngestion, domainAllowed, hostOf, FLOW };
