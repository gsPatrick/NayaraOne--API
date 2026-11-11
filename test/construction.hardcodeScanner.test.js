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

// Verificação independente do Marco 6 (M6-96): o scanner não acusava os próprios exemplos que documenta — a regex de
// valor exigia 5+ dígitos (1500, 2500 e 1000.0 passavam) e percentual inteiro (15) nunca era detectado.
test('M6-96: 1500, 2500, 1000.0 e percentual inteiro (15) são acusados, um por linha, com a linha certa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6v-scanner-'));
  try {
    const linhas = [
      '/* bloco de comentário',
      '   em duas linhas */',
      'const LIMITE = 1500;',
      'const ALCADA_PADRAO = 1000.0;',
      'const COMISSAO_FIXA = 2500;',
      'const MARGEM_MINIMA = 15;',
      'const regra = { minMarginPct: 15 };',
      'const desconto = valor * 15 / 100;',
      'const ok = Math.round(v * 100) / 100;',
      'const ano = 2026;',
      'module.exports = { LIMITE, ALCADA_PADRAO, COMISSAO_FIXA, MARGEM_MINIMA, regra, desconto, ok, ano };',
    ];
    fs.writeFileSync(path.join(dir, 'regra.js'), `${linhas.join('\n')}\n`);
    const r = rodar(dir);
    assert.equal(r.status, 1, r.stdout);
    for (const [n, trecho] of [[3, '1500'], [4, '1000.0'], [5, '2500'], [6, 'MARGEM_MINIMA = 15'], [7, 'minMarginPct: 15'], [8, '15 / 100']]) {
      assert.match(r.stderr, new RegExp(`linha ${n}: valor\\(es\\) suspeito\\(s\\) \\[[^\\]]*${trecho.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `linha ${n} (${trecho}) não acusada:\n${r.stderr}`);
    }
    assert.doesNotMatch(r.stderr, /linha (9|10):/, 'arredondamento (x * 100 / 100) e ano não são regra de negócio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M6-96: o padrão da alçada (R$ 1.000,00) não está mais no código de Obras', () => {
  const src = path.join(__dirname, '..', 'src', 'features', 'construction');
  const achados = [];
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.js'))) {
    const texto = fs.readFileSync(path.join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/DEFAULT_MAX_AUTO_APPROVE_AMOUNT|\b1000(\.0+)?\b(?!\s*\*\s*60)/.test(texto.replace(/24 \* 60 \* 60 \* 1000|1000 \* 60 \* 60/g, ''))) achados.push(f);
  }
  assert.deepEqual(achados, []);
});
