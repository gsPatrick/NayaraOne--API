'use strict';

const https = require('https');
const { URL } = require('url');
const { secureTlsOptions } = require('./tlsPolicy');

// Node 24 (`fetch` global do undici) não aceita `agent`/certificado mTLS sem instalar o pacote `undici` separadamente.
// Em vez de somar uma dependência nova só pra isso, o transporte usa https.request nativo, que já suporta
// `agent: new https.Agent({cert, key})`. Movido de finance/adapters/BankAdapter.js (M9-D209): só o cliente HTTP único o usa.
function httpsRequestJson({ method, url, headers, body, agent, pin }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      { method, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, headers, agent: agent || (pin ? false : defaultAgent()), ...(pin ? { lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)) } : {}), ...secureTlsOptions() },
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

/** Agente padrão: TLS 1.2 ou mais e certificado sempre verificado (M9-D244). */
let agentePadrao = null;
const defaultAgent = () => { if (!agentePadrao) agentePadrao = new https.Agent(secureTlsOptions()); return agentePadrao; };

/** Agente HTTPS com certificado de cliente (mTLS), para o fornecedor que exige; mantém TLS 1.2 ou mais e a verificação do certificado. */
const createMtlsAgent = ({ cert, key }) => new https.Agent(secureTlsOptions({ cert, key }));

module.exports = { httpsRequestJson, createMtlsAgent };
