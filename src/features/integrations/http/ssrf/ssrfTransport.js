'use strict';

const https = require('node:https');
const net = require('node:net');
const { secureTlsOptions } = require('../tlsPolicy');
const { tooLarge, unsupportedMedia, fetchFailed, fetchTimeout } = require('./ssrfErrors');

const baseType = (header) => String(header || '').split(';')[0].trim().toLowerCase();
const tipoPermitido = (tipo, lista) => lista.some((p) => (p.endsWith('/*') ? tipo.startsWith(p.slice(0, -1)) : tipo === p));

/**
 * GET HTTPS ligado ao IP já validado (M9-D245 3.1 itens 4 a 6): conecta no `address`, mantém SNI e Host do nome original, não
 * resolve de novo, não segue redirecionamento (devolve { redirect } para o guarda decidir), corta a leitura ao passar de
 * `maxBytes`, confere o tipo de conteúdo antes de ler o corpo e respeita o tempo total. TLS 1.2+ e certificado verificado.
 * `connect` troca o destino físico (só os testes usam, com NODE_ENV=test).
 */
function fetchPinned({ url, hostname, address, family, timeoutMs, maxBytes, contentTypes, tls = {}, connect }) {
  return new Promise((resolve, reject) => {
    const destino = connect ? connect(address, Number(url.port) || 443) : { host: address, port: Number(url.port) || 443 };
    let terminou = false;
    const fim = (fn, valor) => { if (terminou) return; terminou = true; clearTimeout(relogio); fn(valor); };
    const req = https.request({
      host: destino.host, port: destino.port, family: family || undefined, method: 'GET', path: `${url.pathname}${url.search}`, agent: false,
      servername: net.isIP(hostname) ? undefined : hostname,
      headers: { Host: url.host, Accept: contentTypes.join(', '), 'User-Agent': 'NayaraOne-Fetcher/1' },
      ...secureTlsOptions(tls),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return fim(resolve, { redirect: res.headers.location || null, statusCode: res.statusCode });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return fim(reject, fetchFailed()); }
      const tipo = baseType(res.headers['content-type']);
      if (!tipoPermitido(tipo, contentTypes)) { req.destroy(); return fim(reject, unsupportedMedia()); }
      if (Number(res.headers['content-length']) > maxBytes) { req.destroy(); return fim(reject, tooLarge()); }
      const partes = []; let total = 0;
      res.on('data', (parte) => {
        total += parte.length;
        if (total > maxBytes) { req.destroy(); fim(reject, tooLarge()); return; }
        partes.push(parte);
      });
      res.on('end', () => fim(resolve, { statusCode: res.statusCode, contentType: tipo, buffer: Buffer.concat(partes) }));
      res.on('error', () => fim(reject, fetchFailed()));
    });
    const relogio = setTimeout(() => { req.destroy(); fim(reject, fetchTimeout()); }, timeoutMs);
    req.on('error', () => fim(reject, fetchFailed()));
    req.end();
  });
}

module.exports = { fetchPinned, baseType, tipoPermitido };
