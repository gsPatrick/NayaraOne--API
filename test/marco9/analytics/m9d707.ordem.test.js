'use strict';

// M9-D707 (reabertura) — o resultado do item 2 do DoD não depende da ordem: m9d615.worker passa depois de m9d607.* e m9d607.* passa depois dele,
// no MESMO banco descartável. Roda só no banco descartável (o teste grava com commit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bancoDescartavelAtivo, ambienteDosComandos } = require('../../../scripts/analytics/ci/ambiente');

const RAIZ = path.join(__dirname, '..', '..', '..');
const A = 'test/marco9/analytics';
const ambiente = () => { const env = ambienteDosComandos(); delete env.NODE_TEST_CONTEXT; return env; }; // o filho é uma execução nova do runner
const rodar = (...arquivos) => spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...arquivos.map((f) => `${A}/${f}`)], { cwd: RAIZ, env: ambiente(), encoding: 'utf8' });

test('m9d707 ordem dos arquivos do item 2 não muda o resultado no mesmo banco', { skip: !bancoDescartavelAtivo() && 'exige banco descartável 127.0.0.1' }, () => {
  for (const ordem of [['m9d607.agenda.test.js', 'm9d615.worker.test.js'], ['m9d615.worker.test.js', 'm9d607.worker.test.js', 'm9d607.agenda.test.js']]) {
    const r = rodar(...ordem);
    assert.equal(r.status, 0, `ordem ${ordem.join(' > ')}\n${r.stdout.slice(-1500)}`);
    assert.match(r.stdout, /(ℹ|#) fail 0/);
  }
});
