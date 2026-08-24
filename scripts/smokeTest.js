'use strict';

/**
 * Smoke test mínimo: faz GET /health contra o servidor local e verifica
 * status HTTP 200 e payload success:true. Não substitui os testes de
 * integração/E2E previstos no Marco 2 — é apenas um sinal rápido de vida.
 *
 * Uso: npm run smoke:test  (com o servidor já rodando, ex. via `npm start`)
 */

const http = require('http');

const port = Number(process.env.PORT) || 3000;
const host = process.env.SMOKE_TEST_HOST || 'localhost';
const path = '/health';

const req = http.request({ host, port, path, method: 'GET', timeout: 5000 }, (res) => {
  let raw = '';
  res.on('data', (chunk) => {
    raw += chunk;
  });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`[smoke:test] FALHOU — status HTTP inesperado: ${res.statusCode}`);
      process.exit(1);
    }
    try {
      const body = JSON.parse(raw);
      if (body.success !== true) {
        console.error('[smoke:test] FALHOU — resposta sem success:true', body);
        process.exit(1);
      }
      console.log('[smoke:test] OK —', body.data);
      process.exit(0);
    } catch (err) {
      console.error('[smoke:test] FALHOU — resposta não é JSON válido:', err.message);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`[smoke:test] FALHOU — não foi possível conectar em http://${host}:${port}${path}:`, err.message);
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.error('[smoke:test] FALHOU — timeout aguardando resposta.');
  process.exit(1);
});

req.end();
