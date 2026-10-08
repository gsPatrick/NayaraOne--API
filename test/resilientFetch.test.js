'use strict';

// GAP REAL CORRIGIDO (auditoria "mais um ciclo de 5", 2026-10-08): InsuranceAdapter.js (Seguros,
// Marco 7) não tinha timeout/retry/circuit breaker (INT-005 a INT-008 do contrato). Testa o
// helper genérico src/utils/resilientFetch.js criado para fechar esse gap.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { resilientFetch } = require('../src/utils/resilientFetch');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverUrl(server, path = '/') {
  const { port } = server.address();
  return `http://127.0.0.1:${port}${path}`;
}

test('resilientFetch: timeout real — não trava indefinidamente, erro code=TIMEOUT', async () => {
  const server = await startServer((req, res) => {
    // Nunca responde — simula seguradora travada.
    setTimeout(() => res.end(), 5000);
  });
  try {
    await assert.rejects(
      () => resilientFetch({ circuitKey: `test:timeout:${Date.now()}`, url: serverUrl(server), timeoutMs: 200, maxAttempts: 1 }),
      (err) => err.code === 'TIMEOUT'
    );
  } finally {
    server.close();
  }
});

test('resilientFetch: 503 é retentado e eventualmente sucede (classe de erro retryable)', async () => {
  let callCount = 0;
  const server = await startServer((req, res) => {
    callCount += 1;
    if (callCount < 3) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  try {
    const response = await resilientFetch({ circuitKey: `test:retry503:${Date.now()}`, url: serverUrl(server), maxAttempts: 3 });
    assert.equal(response.status, 200);
    assert.equal(callCount, 3, 'esperava 2 falhas (503) + 1 sucesso');
  } finally {
    server.close();
  }
});

test('resilientFetch: 400 (validação) NUNCA é retentado — INT-006', async () => {
  let callCount = 0;
  const server = await startServer((req, res) => {
    callCount += 1;
    res.writeHead(400);
    res.end();
  });
  try {
    const response = await resilientFetch({ circuitKey: `test:no-retry-400:${Date.now()}`, url: serverUrl(server), maxAttempts: 3 });
    assert.equal(response.status, 400);
    assert.equal(callCount, 1, 'erro de validação (400) não deveria gerar nenhum retry');
  } finally {
    server.close();
  }
});

test('resilientFetch: circuit breaker abre após falhas consecutivas e bloqueia chamadas seguintes (INT-007)', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  const circuitKey = `test:circuit:${Date.now()}`;
  try {
    // 5 falhas consecutivas (maxAttempts=1 pra não misturar retry com circuito) abrem o circuito.
    for (let i = 0; i < 5; i += 1) {
      await resilientFetch({ circuitKey, url: serverUrl(server), maxAttempts: 1 }).catch(() => {});
    }
    await assert.rejects(
      () => resilientFetch({ circuitKey, url: serverUrl(server), maxAttempts: 1 }),
      (err) => err.code === 'CIRCUIT_OPEN'
    );
  } finally {
    server.close();
  }
});

after(() => {
  // Sem conexão de banco neste arquivo — nada para fechar.
});
