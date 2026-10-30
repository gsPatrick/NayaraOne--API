'use strict';

// M9-D605 (reabertura, reverificação V-BI-3) — a porta única runFormula não pode ser contornada: nenhum arquivo de src/features/analytics chama
// `.compute(` de uma fórmula diretamente, salvo os que RODAM a fórmula por definição (porta, catálogo de casos, checagem de determinismo) e a
// reconciliação por linhas-fonte (recebe a lista bruta da fonte, em formato próprio já validado pelo filtro assinado). Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../../../src/features/analytics');
const ALLOWED = new Set(['metrics/formulaRun.js', 'metrics/formulaCatalog.js', 'metrics/formulaDeterminism.js', 'metrics/sourceRefs.reconcile.js']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.js') ? [full] : [];
  });
}
const code = (line) => line.replace(/\/\/.*$/, '').replace(/^\s*(\*|\/\*).*$/, '');

test('m9d605 nenhum executor de KPI chama formula.compute direto fora da porta única', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (/\.compute\s*\(/.test(code(line))) offenders.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(offenders, [], `chamadas diretas a compute: ${offenders.join(', ')}`);
});

test('m9d605 as exceções da varredura existem e continuam sendo as únicas', () => {
  for (const rel of ALLOWED) assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
});
