'use strict';

// Marco 9, M9-D244 (reabertura da rodada 2: N5 e N9) — faixas IPv6 que embutem IPv4 e o redirecionamento sem DNS fixado. Sem banco.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isBlockedIp } = require('../../../src/features/integrations/http/ssrf/ipRanges');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');

const servidores = [];
after(async () => { await Promise.all(servidores.map((s) => new Promise((r) => s.close(r)))); });

test('n5_faixas_ipv6_que_embutem_ipv4_ou_sao_reservadas_sao_bloqueadas', () => {
  const proibidos = ['::127.0.0.1', '::7f00:1', '::10.0.0.5', '::169.254.169.254', '::ffff:0:127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '64:ff9b:1::1', '64:ff9b:1:ffff::1', 'fec0::1', 'feff::1',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', 'fd00::1', 'fe80::1', '2002:7f00:1::1'];
  for (const ip of proibidos) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '93.184.216.34', '::ffff:93.184.216.34', '2a00:1450:4001::1']) assert.equal(isBlockedIp(ip), false, ip);
});

test('n5_cliente_recusa_ipv6_embutindo_loopback_em_qualquer_modo', async () => {
  for (const [environment, egressMode] of [['PRODUCTION', 'enforce'], ['SANDBOX', 'log']]) {
    const c = new IntegrationHttpClient({ environment, egressMode, allowedHosts: ['::127.0.0.1', '::ffff:0:127.0.0.1', 'fec0::1'] });
    for (const url of ['https://[::127.0.0.1]/x', 'https://[::ffff:0:127.0.0.1]/x', 'https://[64:ff9b:1::1]/x', 'https://[fec0::1]/x']) {
      await assert.rejects(c.guard(url, 'GET'), (e) => e.code === 'INTEGRATION_EGRESS_BLOCKED', `${environment} ${url}`);
    }
  }
});

function subir() {
  const visitas = [];
  const srv = http.createServer((req, res) => {
    visitas.push(req.url);
    if (req.url === '/vai') { res.statusCode = 302; res.setHeader('location', '/destino'); return res.end(); }
    res.end('destino');
  });
  servidores.push(srv);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, visitas })));
}

test('n9_sem_dns_fixado_o_cliente_tambem_nao_segue_redirecionamento', async () => {
  const { port, visitas } = await subir();
  const cliente = new IntegrationHttpClient({ environment: 'SANDBOX', egressMode: 'log', allowedHosts: ['127.0.0.1'], maxAttempts: 1 });
  const viaFetch = await cliente.fetch(`http://127.0.0.1:${port}/vai`, {});
  assert.equal(viaFetch.status, 302, 'fetch: o 302 volta ao chamador');
  const viaRequest = await cliente.request({ method: 'GET', url: `http://127.0.0.1:${port}/vai`, maxAttempts: 1 }).catch((e) => e);
  assert.ok(viaRequest.status === 302 || viaRequest.statusCode === 302 || viaRequest.code, 'request: o 302 não é seguido');
  assert.deepEqual([...new Set(visitas)], ['/vai'], 'o destino do redirecionamento nunca foi visitado');
});
