'use strict';

const { resolveAndValidate } = require('./ssrfResolve');
const { fetchPinned } = require('./ssrfTransport');

const emTeste = () => process.env.NODE_ENV === 'test';
const PROBE_TYPES = ['text/*', 'application/*', 'image/*', 'video/*', 'audio/*', 'font/*'];
const PROBE_MAX_BYTES = 4096;

/**
 * Sonda de URL para quem só precisa saber "o destino é público e para onde ele redireciona" (M9-D433, validateExternalUrl do Marketing). Não guarda nem
 * interpreta o corpo: o conteúdo nunca é usado. Toda a parte de rede fica aqui, na pasta que a fronteira de integrações reserva para HTTP.
 */

/** O nome resolve só para endereços públicos? Devolve { ok:true, address, family } ou { ok:false, reason } (PRIVATE_IP, DNS_FAILED). */
async function checkPublicHost(hostname, { resolver } = {}) {
  try {
    const [alvo] = await resolveAndValidate(hostname, { resolver });
    return { ok: true, address: alvo.address, family: alvo.family };
  } catch (err) {
    if (err && err.code === 'INTEGRATION_SSRF_BLOCKED') return { ok: false, reason: err.reason || 'BLOCKED' };
    return { ok: false, reason: 'DNS_FAILED' };
  }
}

/**
 * GET HTTPS preso ao IP já validado, sem seguir redirecionamento. Devolve { redirect: string|null, statusCode }: `redirect` vem preenchido quando o destino responde 3xx
 * com Location. Resposta 2xx (mesmo grande ou de tipo estranho) é destino final. Falha de rede, tempo esgotado ou 4xx/5xx lançam (o chamador decide: falha fechada).
 */
async function probeRedirect(rawUrl, { address, family, timeoutMs, _tls, _connect } = {}) {
  const url = new URL(rawUrl);
  try {
    const r = await fetchPinned({
      url, hostname: url.hostname, address, family, timeoutMs, maxBytes: PROBE_MAX_BYTES, contentTypes: PROBE_TYPES,
      tls: emTeste() ? _tls : undefined, connect: emTeste() ? _connect : undefined,
    });
    if (Object.prototype.hasOwnProperty.call(r, 'redirect')) return { redirect: r.redirect || null, statusCode: r.statusCode };
    return { redirect: null, statusCode: r.statusCode };
  } catch (err) {
    if (err && (err.code === 'INTEGRATION_FETCH_TOO_LARGE' || err.code === 'INTEGRATION_FETCH_UNSUPPORTED_MEDIA')) return { redirect: null, statusCode: 200 };
    throw err;
  }
}

module.exports = { checkPublicHost, probeRedirect };
