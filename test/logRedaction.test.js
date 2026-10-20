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
