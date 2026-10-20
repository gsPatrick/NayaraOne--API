'use strict';
// Conferência Nayara 19/10/2026: os logs de teste traziam ~350 "Bearer eyJ..." (JWT completo).
// Origem: pino-http registrava req.headers.authorization. src/utils/logger.js agora redige.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('logger real: Authorization/Cookie saem [REDACTED] e o JWT nunca aparece na saída', () => {
  const code = "require('./src/utils/logger').info({req:{headers:{authorization:'Bearer eyJSEGREDO',cookie:'sid=SEGREDO2',host:'h'}}},'m')";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('eyJSEGREDO') && !r.stdout.includes('SEGREDO2'), r.stdout);
  assert.ok(r.stdout.includes('[REDACTED]') && r.stdout.includes('"host":"h"'));
});

// Logger de requisição de ponta a ponta: sobe um Express com o MESMO middleware do app, envia
// uma requisição real com Authorization, Cookie e token na query, e lê o que foi escrito.
test('requestLogger real (HTTP): nenhum Authorization, Cookie ou token de query aparece na saída', () => {
  const code = `
    const express = require('express');
    const http = require('http');
    const { requestLoggerMiddleware } = require('./src/middlewares/requestLogger.middleware');
    const app = express();
    app.use(requestLoggerMiddleware);
    app.get('/x', (req, res) => { res.setHeader('set-cookie', 'sid=SEGREDO-SETCOOKIE; HttpOnly'); res.json({ ok: true }); });
    const srv = app.listen(0, () => {
      const req = http.request({ port: srv.address().port, path: '/x?token=SEGREDO-QS&page=2&password=SEGREDO-PW', headers: {
        authorization: 'Bearer eyJSEGREDO-JWT', cookie: 'sid=SEGREDO-COOKIE', 'x-api-key': 'SEGREDO-APIKEY', 'x-refresh-token': 'SEGREDO-REFRESH' } }, (res) => {
        res.resume(); res.on('end', () => setTimeout(() => srv.close(() => process.exit(0)), 200));
      });
      req.end();
    });`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/"statusCode":200/.test(r.stdout), r.stdout);
  assert.ok(!/SEGREDO|eyJ/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.includes('[REDACTED]') && r.stdout.includes('page=2'), r.stdout);
});

test('redactUrl: mascara só os parâmetros sensíveis e preserva o resto', () => {
  const { redactUrl } = require('../src/utils/logger');
  assert.equal(redactUrl('/a?token=abc&x=1&access_token=z'), '/a?token=[REDACTED]&x=1&access_token=[REDACTED]');
  assert.equal(redactUrl('/a/b'), '/a/b');
  assert.equal(redactUrl('/a?x=1&flag'), '/a?x=1&flag');
});

test('logger: campos sensíveis de objetos de log saem [REDACTED]', () => {
  const code = "require('./src/utils/logger').error({ ctx: { password: 'SEGREDO-PW', token: 'SEGREDO-TK', ok: 1 }, user: { passwordHash: 'SEGREDO-H' } }, 'm')";
  const r = spawnSync(process.execPath, ['-e', code], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // '*.password' cobre um nível; o teste confirma o comportamento real do redact do pino
  assert.ok(!/SEGREDO-PW|SEGREDO-TK|SEGREDO-H/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.includes('"ok":1'));
});
