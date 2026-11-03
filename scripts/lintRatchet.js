'use strict';

/**
 * Etapa de lint do CI (Guia §13). Roda o ESLint no projeto inteiro (regras recomendadas, nada
 * desligado) e FALHA se houver qualquer erro fora da linha de base.
 *
 * Linha de base (scripts/lint-baseline.json): erros de lint que já existiam em arquivos dos
 * Marcos 4/5 (Financeiro/Jurídico/Cobrança), que estão sendo alterados em paralelo por outra
 * frente e não puderam ser tocados nesta rodada. Cada arquivo tem um TETO de erros: subir o
 * número, ou aparecer erro em arquivo fora da lista, quebra o CI. Ao corrigir, baixe o número
 * (ou remova a linha) — `node scripts/lintRatchet.js --update` regrava a base só para baixo.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ESLINT_BIN = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
const BASELINE = path.join(__dirname, 'lint-baseline.json');

const res = spawnSync(process.execPath, [ESLINT_BIN, '.', '-f', 'json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (!res.stdout) {
  console.error(res.stderr);
  process.exit(2);
}
const report = JSON.parse(res.stdout);
const current = {};
let warnings = 0;
for (const r of report) {
  const rel = path.relative(ROOT, r.filePath);
  for (const m of r.messages) {
    if (m.severity === 2) current[rel] = (current[rel] || 0) + 1;
    else warnings += 1;
  }
}
const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};

if (process.argv.includes('--update')) {
  const next = {};
  for (const [f, n] of Object.entries(baseline)) if (current[f]) next[f] = Math.min(n, current[f]);
  fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`linha de base atualizada: ${Object.keys(next).length} arquivo(s), ${Object.values(next).reduce((a, b) => a + b, 0)} erro(s).`);
  process.exit(0);
}

const violations = [];
for (const [f, n] of Object.entries(current)) {
  if (n > (baseline[f] || 0)) violations.push(`${f}: ${n} erro(s) (teto da linha de base: ${baseline[f] || 0})`);
}
const totalErrors = Object.values(current).reduce((a, b) => a + b, 0);
console.log(`ESLint: ${report.length} arquivos, ${totalErrors} erro(s) (todos dentro da linha de base Marcos 4/5: ${Object.keys(baseline).length} arquivo(s)), ${warnings} aviso(s).`);
if (violations.length) {
  console.error('Erros de lint NOVOS (fora da linha de base):');
  for (const v of violations) console.error(`  - ${v}`);
  spawnSync(process.execPath, [ESLINT_BIN, ...violations.map((v) => v.split(':')[0])], { cwd: ROOT, stdio: 'inherit' });
  process.exit(1);
}
