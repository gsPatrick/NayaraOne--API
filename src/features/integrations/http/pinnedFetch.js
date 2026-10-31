'use strict';

const https = require('node:https');
const { secureTlsOptions } = require('./tlsPolicy');

const SEM_CORPO = new Set([101, 204, 205, 304]);

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

function headersOf(init) {
  const h = init.headers;
  if (!h) return {};
  if (typeof h.forEach === 'function' && typeof h.get === 'function') { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  return { ...h };
}

/**
 * fetch preso ao endereço já validado (M9-D245, DNS fixado): conecta no IP `pin`, mantém SNI, Host e a verificação do certificado do nome
 * original, não resolve de novo e NÃO segue redirecionamento (a resposta 3xx volta ao chamador, como `redirect: 'manual'`). Devolve um Response.
 * TLS 1.2 ou mais e certificado verificado sempre (`testTls`, só com NODE_ENV=test, acrescenta a autoridade do certificado de teste).
 */
function pinnedFetch(rawUrl, init = {}, pin, testTls) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') return Promise.reject(Object.assign(new Error('Conexão fixada exige https.'), { code: 'INTEGRATION_TLS_REQUIRED' }));
  const body = init.body === undefined || init.body === null ? null : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body instanceof Uint8Array ? init.body : String(init.body)));
  return new Promise((resolve, reject) => {
    if (init.signal && init.signal.aborted) return reject(abortError());
    const req = https.request({
      protocol: 'https:', hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 443, path: `${url.pathname}${url.search}`, method: init.method || 'GET',
      headers: headersOf(init), agent: false,
      lookup: (_host, opcoes, cb) => (opcoes && opcoes.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
      ...secureTlsOptions(process.env.NODE_ENV === 'test' && testTls ? testTls : {}), // só o teste confia numa autoridade própria
    }, (res) => {
      const partes = [];
      res.on('data', (p) => partes.push(p));
      res.on('error', reject);
      res.on('end', () => {
        const headers = new Headers();
        Object.entries(res.headers).forEach(([k, v]) => { (Array.isArray(v) ? v : [v]).forEach((x) => headers.append(k, x)); });
        resolve(new Response(SEM_CORPO.has(res.statusCode) ? null : Buffer.concat(partes), { status: res.statusCode, statusText: res.statusMessage, headers }));
      });
    });
    req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { pinnedFetch };
