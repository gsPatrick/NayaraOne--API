'use strict';

// Marco 9, M9-D215 (reabertura M2) — INT-005 no cliente HTTP (política em utils/resilientFetch, da M9-D216): operação que altera estado (POST, PUT) NÃO é repetida às cegas em timeout ou
// 502/503/504, a menos que traga Idempotency-Key (mesma chave em todas as tentativas) ou seja declarada idempotente; 429 é repetido
// (o fornecedor recusou sem processar) e GET segue com o retry de erro transitório.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { resilientFetch } = require('../../../src/utils/resilientFetch');

const servidores = [];
const sobe = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  servidores.push(s);
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/x` }));
});
after(() => { servidores.forEach((s) => s.close()); });
const chave = () => `m9d216-http:${Date.now()}:${Math.random()}`;

test('retry_post_sem_idempotencia_nao_repete_em_503', async () => {
  let n = 0;
  const { url } = await sobe((req, res) => { n += 1; res.writeHead(503); res.end(); });
  for (const method of ['POST', 'PUT']) {
    n = 0;
    const r = await resilientFetch({ circuitKey: chave(), url, method, body: '{}', maxAttempts: 3 });
    assert.equal(r.status, 503);
    assert.equal(n, 1, `${method} sem chave de idempotência: uma única chamada ao fornecedor`);
  }
});

test('retry_post_sem_idempotencia_nao_repete_em_timeout', async () => {
  let n = 0;
  const { url } = await sobe((req) => { n += 1; req.on('end', () => {}); /* nunca responde */ });
  await assert.rejects(resilientFetch({ circuitKey: chave(), url, method: 'POST', body: '{}', timeoutMs: 150, maxAttempts: 3 }), (e) => e.code === 'TIMEOUT');
  assert.equal(n, 1, 'timeout após o envio não gera segundo envio');
});

test('retry_post_com_idempotency_key_repete_com_a_mesma_chave', async () => {
  const vistas = [];
  const { url } = await sobe((req, res) => {
    vistas.push(req.headers['idempotency-key']);
    if (vistas.length < 3) { res.writeHead(503); res.end(); return; }
    res.writeHead(200); res.end('ok');
  });
  const r = await resilientFetch({ circuitKey: chave(), url, method: 'POST', headers: { 'Idempotency-Key': 'k-1' }, body: '{}', maxAttempts: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(vistas, ['k-1', 'k-1', 'k-1']);
});

test('retry_post_declarado_idempotente_repete', async () => {
  let n = 0;
  const { url } = await sobe((req, res) => { n += 1; if (n < 2) { res.writeHead(502); res.end(); return; } res.writeHead(200); res.end('ok'); });
  const r = await resilientFetch({ circuitKey: chave(), url, method: 'POST', body: 'a=b', idempotent: true, maxAttempts: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test('retry_post_429_e_repetido_porque_nao_foi_processado', async () => {
  let n = 0;
  const { url } = await sobe((req, res) => { n += 1; if (n < 2) { res.writeHead(429, { 'retry-after': '0' }); res.end(); return; } res.writeHead(200); res.end('ok'); });
  const r = await resilientFetch({ circuitKey: chave(), url, method: 'POST', body: '{}', maxAttempts: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test('retry_get_segue_repetindo_em_503', async () => {
  let n = 0;
  const { url } = await sobe((req, res) => { n += 1; if (n < 3) { res.writeHead(503); res.end(); return; } res.writeHead(200); res.end('ok'); });
  const r = await resilientFetch({ circuitKey: chave(), url, method: 'GET', maxAttempts: 3 });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
});

test('retry_post_reset_de_conexao_apos_envio_nao_repete_mas_conexao_recusada_repete', async () => {
  let n = 0;
  const { url } = await sobe((req) => { n += 1; req.socket.destroy(); }); // cai depois de receber: pode ter sido processado
  await assert.rejects(resilientFetch({ circuitKey: chave(), url, method: 'POST', body: '{}', maxAttempts: 3 }));
  assert.equal(n, 1, 'queda depois do envio em POST sem chave: nenhum segundo envio');
  // Porta fechada: nada saiu, repetir é seguro (3 tentativas, nenhuma chegou a lugar nenhum).
  const fechada = await sobe(() => {});
  const porta = fechada.s.address().port;
  await new Promise((r) => fechada.s.close(r));
  const t0 = Date.now();
  await assert.rejects(resilientFetch({ circuitKey: chave(), url: `http://127.0.0.1:${porta}/x`, method: 'POST', body: '{}', maxAttempts: 2 }));
  assert.ok(Date.now() - t0 >= 400, 'a recusa de conexão ainda passa pelo backoff da segunda tentativa');
});
