'use strict';

// Marco 9, M9-D217 — resilientFetch delega ao componente do circuito e nenhum limiar de circuito existe fora da política (Guia §6).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const { resilientFetch } = require('../../../src/utils/resilientFetch');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');

const RAIZ = path.join(__dirname, '..', '..', '..');
let server;
let chamadas = 0;
const url = () => `http://127.0.0.1:${server.address().port}/`;

before(async () => {
  server = http.createServer((req, res) => { chamadas += 1; res.writeHead(500); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(() => server.close());

test('circuito_resilientfetch_delega', async () => {
  const circuitKey = `test:delega:${Date.now()}`;
  for (let i = 0; i < 5; i += 1) await resilientFetch({ circuitKey, url: url(), maxAttempts: 1 });
  const antes = chamadas;
  await assert.rejects(
    resilientFetch({ circuitKey, url: url(), maxAttempts: 1 }),
    (e) => e.statusCode === 503 && e.code === 'INTEGRATION_CIRCUIT_OPEN' && e.circuitKey === circuitKey,
    'a mesma máquina de estados responde 503 INTEGRATION_CIRCUIT_OPEN',
  );
  assert.equal(chamadas, antes, 'o circuito aberto não chega ao fornecedor');
  // chave diferente é circuito diferente
  const outro = await resilientFetch({ circuitKey: `test:delega:outro:${Date.now()}`, url: url(), maxAttempts: 1 });
  assert.equal(outro.status, 500);
  // o cliente de uma connection NÃO conta por conta própria: o circuito persistido é do Dispatch Service
  const cliente = new IntegrationHttpClient({ providerCode: 'messaging-sandbox', connectionId: '00000000-0000-4000-8000-000000000001', allowedHosts: ['127.0.0.1'], environment: 'SANDBOX', egressMode: 'log', maxAttempts: 1 });
  for (let i = 0; i < 8; i += 1) {
    const r = await cliente.request({ url: url() });
    assert.equal(r.status, 500, 'seguiu chamando: sem contagem em memória');
  }
  assert.equal(fs.readFileSync(path.join(RAIZ, 'src/utils/resilientFetch.js'), 'utf8').includes('new Map('), false, 'o Map em memória do resilientFetch foi substituído');
});

function arquivos(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

test('circuito_limiares_so_da_policy_sem_numero_espalhado', () => {
  const PERMITIDOS = [/health[\\/]circuitPolicy\.js$/, /integrations[\\/]providers[\\/]/, /integrations[\\/]registry[\\/]connections/];
  const LIMIAR = /\b\w*(threshold|cooldown|half_?open_?max|halfopenmax|close_?after|failure_?limit|max_?consecutive_?fail)\w*\s*[:=]\s*[-(]?\s*\d/i;
  const achados = [];
  const alvos = [...arquivos(path.join(RAIZ, 'src/features/integrations')), path.join(RAIZ, 'src/utils/resilientFetch.js')];
  for (const f of alvos) {
    if (PERMITIDOS.some((re) => re.test(f))) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((linha, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(linha)) return;
      if (LIMIAR.test(linha)) achados.push(`${path.relative(RAIZ, f)}:${i + 1}: ${linha.trim()}`);
    });
  }
  assert.deepEqual(achados, [], `limiar de circuito fora da política:\n${achados.join('\n')}`);
});
