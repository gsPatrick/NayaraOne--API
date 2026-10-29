'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

/**
 * Certificado autoassinado gerado em tempo de execução (nada de chave em arquivo versionado). Serve a `localhost`; o teste
 * entrega o certificado como autoridade (`ca`) ao cliente, que continua verificando certificado e nome do host.
 */
function gerarCertificado(hosts = ['localhost']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-tls-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${hosts[0]}`, '-addext', `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}`], { stdio: 'ignore' });
  const par = { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
  fs.rmSync(dir, { recursive: true, force: true });
  return par;
}

/** Sobe um servidor HTTPS local (porta livre) que responde `{ok:true}`; `tlsOptions` troca versões e cifras. Devolve { port, close }. */
function subirServidor(par, tlsOptions = {}, handler) {
  const server = https.createServer({ ...par, ...tlsOptions }, handler || ((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }));
  server.on('tlsClientError', () => {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

module.exports = { gerarCertificado, subirServidor };
