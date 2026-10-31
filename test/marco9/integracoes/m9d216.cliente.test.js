'use strict';

// Marco 9, M9-D216 (reabertura da rodada 2, N3) — o cliente HTTP único escolhe as tentativas pela natureza da chamada: leitura e operação idempotente
// (declarada ou com Idempotency-Key) usam `maxAttempts`; a que altera estado sem chave usa `stateChangeMaxAttempts`. Sem banco.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');

const servidores = [];
after(() => servidores.forEach((s) => s.close()));

function instavel() {
  const chamadas = [];
  const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { chamadas.push(`${req.method} ${req.url}`); res.writeHead(503); res.end(); }); });
  servidores.push(s);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ chamadas, base: `http://127.0.0.1:${s.address().port}` })));
}
const cliente = (extra = {}) => new IntegrationHttpClient({ connectionId: '00000000-0000-4000-8000-00000000d216', environment: 'SANDBOX', egressMode: 'log', allowedHosts: ['127.0.0.1'], maxAttempts: 3, stateChangeMaxAttempts: 1, timeouts: { readMs: 2000, writeMs: 2000 }, ...extra });

test('cliente_tentativas_pela_natureza_da_chamada', async () => {
  const { chamadas, base } = await instavel();
  const c = cliente();
  assert.equal((await c.request({ method: 'GET', url: `${base}/leitura` })).status, 503);
  assert.equal(chamadas.filter((x) => x.endsWith('/leitura')).length, 3, 'leitura: 3 tentativas');
  await c.request({ method: 'POST', url: `${base}/cotacao`, idempotent: true });
  assert.equal(chamadas.filter((x) => x.endsWith('/cotacao')).length, 3, 'POST declarado idempotente: 3');
  await c.request({ method: 'POST', url: `${base}/com-chave`, headers: { 'Idempotency-Key': 'k-1' } });
  assert.equal(chamadas.filter((x) => x.endsWith('/com-chave')).length, 3, 'POST com Idempotency-Key: 3');
  await c.request({ method: 'POST', url: `${base}/emissao` });
  assert.equal(chamadas.filter((x) => x.endsWith('/emissao')).length, 1, 'POST sem chave: uma só');
  await c.scoped(['127.0.0.1']).request({ method: 'PUT', url: `${base}/emissao-scoped` });
  assert.equal(chamadas.filter((x) => x.endsWith('/emissao-scoped')).length, 1, 'o cliente derivado mantém a regra');
  await c.request({ method: 'POST', url: `${base}/explicito`, maxAttempts: 2, idempotent: true });
  assert.equal(chamadas.filter((x) => x.endsWith('/explicito')).length, 2, 'o valor da chamada vence');
});

test('cliente_sem_stateChangeMaxAttempts_mantem_o_comportamento_anterior', async () => {
  const { chamadas, base } = await instavel();
  await cliente({ stateChangeMaxAttempts: undefined, maxAttempts: 2 }).request({ method: 'POST', url: `${base}/antigo` });
  assert.equal(chamadas.filter((x) => x.endsWith('/antigo')).length, 1, 'POST sem chave só repete 429 e falha antes do envio (resilientFetch): 503 não repete');
});
