'use strict';

// Matriz de fechamento do Marco 6 (10/11/2026) — M6-96: o scanner de hard-code que o CI roda sobre Obras
// (scripts/scanConstructionHardcode.js) não tinha teste próprio. Prova as duas pontas: o código atual de
// Obras passa limpo e uma margem/valor fixado em código é acusado (exit 1), com o marcador de exceção
// "scanner:allow" respeitado.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCANNER = path.join(__dirname, '..', 'scripts', 'scanConstructionHardcode.js');
const rodar = (dir) => spawnSync(process.execPath, [SCANNER], { encoding: 'utf8', env: { ...process.env, ...(dir ? { SCAN_CONSTRUCTION_DIR: dir } : {}) } });

test('M6-96: o módulo de Obras atual passa no scanner de hard-code (exit 0)', () => {
  const r = rodar(null);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nenhum hard-code suspeito/);
});

test('M6-96: margem mínima ou valor fixado em código é acusado (exit 1); "scanner:allow" é respeitado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-scanner-'));
  try {
    fs.writeFileSync(path.join(dir, 'margem.js'), "const MIN_MARGIN = 0.15;\nconst TETO = 50000;\nmodule.exports = { MIN_MARGIN, TETO };\n");
    const ruim = rodar(dir);
    assert.equal(ruim.status, 1);
    assert.match(ruim.stderr, /0\.15/);
    assert.match(ruim.stderr, /50000/);
    fs.writeFileSync(path.join(dir, 'margem.js'), 'const ESCALA = 0.5; // scanner:allow (fator de arredondamento, não é regra de negócio)\nmodule.exports = { ESCALA };\n');
    assert.equal(rodar(dir).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
