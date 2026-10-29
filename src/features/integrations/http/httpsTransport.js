'use strict';

const https = require('https');
const { URL } = require('url');

// Node 24 (`fetch` global do undici) não aceita `agent`/certificado mTLS sem instalar o pacote `undici` separadamente.
// Em vez de somar uma dependência nova só pra isso, o transporte usa https.request nativo, que já suporta
// `agent: new https.Agent({cert, key})`. Movido de finance/adapters/BankAdapter.js (M9-D209): só o cliente HTTP único o usa.
function httpsRequestJson({ method, url, headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      { method, hostname: target.hostname, path: `${target.pathname}${target.search}`, headers, agent },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Agente HTTPS com certificado de cliente (mTLS), para o fornecedor que exige. */
const createMtlsAgent = ({ cert, key }) => new https.Agent({ cert, key });

module.exports = { httpsRequestJson, createMtlsAgent };
